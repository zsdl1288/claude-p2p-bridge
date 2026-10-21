#pragma once
#include "platform.hpp"
#include <cmath>
#include <condition_variable>
#include <set>

namespace DesktopSpeedTest {
inline std::string Text(const Json& value, const char* key, size_t maximum = 128) {
    if (!value.is_object() || !value.contains(key) || !value[key].is_string()) return {};
    const auto text = value[key].get<std::string>();
    return text.size() <= maximum ? text : std::string{};
}
inline bool Integer(const Json& value, const char* key, uint64_t maximum) {
    if (!value.is_object() || !value.contains(key)) return false;
    const auto& number = value[key];
    if (number.is_number_unsigned()) return number.get<uint64_t>() <= maximum;
    return number.is_number_integer() && number.get<int64_t>() >= 0 && static_cast<uint64_t>(number.get<int64_t>()) <= maximum;
}
inline Json Job(const Json& response) {
    if (!response.is_object()) return Json::object();
    const auto job = response.contains("job") ? response["job"] : response;
    const auto state = Text(job, "state");
    return !Text(job, "id").empty() && (state == "running" || state == "completed" || state == "cancelled" || state == "failed") ? job : Json::object();
}
inline bool Running(const Json& response) { return Text(Job(response), "state") == "running"; }
inline std::vector<Json> BaseTargets(const Json& response) {
    std::vector<Json> targets;
    if (!response.is_object() || !response.contains("targets") || !response["targets"].is_array()) return targets;
    std::set<std::string> seen;
    for (const auto& row : response["targets"]) {
        const auto id = Text(row, "id"), role = Text(row, "role");
        if (targets.size() >= 16 || id.empty() || (role != "client" && role != "host") || !seen.insert(id).second) continue;
        targets.push_back({{"id", id}, {"name", Text(row, "name", 256)}, {"address", Text(row, "address", 64)}, {"role", role}});
    }
    return targets;
}
class OwnedJobs {
    mutable std::mutex mutex_;
    uint64_t epoch_ = 0;
    std::set<std::string> jobs_, cancelling_;
public:
    uint64_t BeginView() { std::lock_guard lock(mutex_); return ++epoch_; }
    bool Current(uint64_t epoch) const { std::lock_guard lock(mutex_); return epoch_ == epoch; }
    bool Register(const std::string& id, uint64_t epoch) {
        std::lock_guard lock(mutex_);
        // A successful new start replaces the backend's sole retained job;
        // every previous owned ID is already terminal or no longer exists.
        jobs_.clear(); cancelling_.clear(); jobs_.insert(id); return epoch != epoch_;
    }
    void ObserveOnly(const std::string& current) {
        std::lock_guard lock(mutex_);
        for (auto it = jobs_.begin(); it != jobs_.end();) {
            if (*it == current) ++it;
            else { cancelling_.erase(*it); it = jobs_.erase(it); }
        }
    }
    std::vector<std::string> Retire() { std::lock_guard lock(mutex_); ++epoch_; return {jobs_.begin(), jobs_.end()}; }
    bool ClaimCancel(const std::string& id) { std::lock_guard lock(mutex_); return jobs_.contains(id) && cancelling_.insert(id).second; }
    void FinishCancel(const std::string& id, bool success) { std::lock_guard lock(mutex_); cancelling_.erase(id); if (success) jobs_.erase(id); }
    void Forget(const std::string& id) { std::lock_guard lock(mutex_); jobs_.erase(id); cancelling_.erase(id); }
};
constexpr uint64_t MaxBytes = 67108864;
class StatusEpoch {
    uint64_t revision_ = 0;
public:
    uint64_t Capture() const { return revision_; }
    void Started() { ++revision_; }
    void Settled() { ++revision_; }
    bool Accept(uint64_t captured) const { return captured == revision_; }
};
struct Number { bool known = false; double value = 0; };
inline Number Numeric(const Json& object, const char* key, double maximum) {
    if (!object.is_object() || !object.contains(key) || !object[key].is_number()) return {};
    const auto value = object[key].get<double>();
    return std::isfinite(value) && value >= 0 && value <= maximum ? Number{true, value} : Number{};
}
inline std::vector<Json> Targets(const Json& response) {
    auto targets = BaseTargets(response);
    for (auto& target : targets) {
        target["supported"] = false;
        for (const auto& original : response["targets"]) if (Text(original, "id") == Text(target, "id")) {
            target["supported"] = original.contains("supported") && original["supported"] == true; break;
        }
    }
    return targets;
}
inline bool CanStart(const Json& state) {
    if (!state.is_object() || !state.contains("available") || state["available"] != true ||
        !state.contains("busy") || state["busy"] != false || !Integer(state, "retryAfterMs", 15000) ||
        state["retryAfterMs"] != 0 || Running(state)) return false;
    const auto targets = Targets(state);
    return std::any_of(targets.begin(), targets.end(), [](const auto& item) { return item["supported"] == true; });
}
inline bool CanStartTarget(const Json& state, const std::string& id) {
    if (id.empty() || !CanStart(state)) return false;
    const auto targets = Targets(state);
    return std::any_of(targets.begin(), targets.end(), [&id](const auto& item) { return Text(item, "id") == id && item["supported"] == true; });
}
inline std::wstring Rate(Number speed, bool bits = true) {
    if (!speed.known) return L"—";
    std::wostringstream text; text << std::fixed << std::setprecision(2) << speed.value * (bits ? 8.0 : 1.0) / 1000000.0;
    return text.str() + (bits ? L" Mbps" : L" MB/s");
}
inline std::wstring Milliseconds(Number latency) {
    if (!latency.known) return L"—";
    std::wostringstream text; text << std::fixed << std::setprecision(1) << latency.value;
    return text.str() + L" ms";
}
inline std::wstring CompactRate(Number speed) {
    if (!speed.known) return L"—";
    const double divisor = speed.value >= 1000000 ? 1000000 : speed.value >= 1000 ? 1000 : 1;
    std::wostringstream text; text << std::fixed << std::setprecision(divisor == 1000000 ? 2 : divisor == 1000 ? 1 : 0) << speed.value / divisor;
    return text.str() + (divisor == 1000000 ? L" MB/s" : divisor == 1000 ? L" KB/s" : L" B/s");
}
inline std::wstring DeviceLive(const Json& device) {
    if (!device.is_object() || !device.contains("online") || device["online"] != true) return L"—";
    const auto up = Numeric(device, "uploadBytesPerSecond", 1e12), down = Numeric(device, "downloadBytesPerSecond", 1e12);
    const bool self = device.contains("self") && device["self"] == true;
    const auto latency = self ? Number{} : Numeric(device, "latencyMs", 120000);
    std::wstring delay = L"—";
    if (latency.known) { std::wostringstream text; text << std::fixed << std::setprecision(0) << latency.value; delay = text.str() + L" ms"; }
    return L"↑ " + CompactRate(up) + L" ↓ " + CompactRate(down) + L" · " + delay;
}
inline std::wstring Reason(const Json& state) {
    const auto reason = Text(state, "reason");
    if (reason == "ready") return L"选择已连接设备后，点击“开始测速”。";
    if (reason == "unsupported" || reason == "peer-unsupported") return L"双方均需升级至 1.1.9 才能进行通道测速。";
    if (reason == "model-busy") return L"模型任务正在执行或排队，请稍后测速。";
    if (reason == "recovery-busy") return L"Bridge 正在恢复通道，请稍后测速。";
    if (reason == "cooldown") return L"测速冷却中，每次开始至少间隔 15 秒。";
    if (reason == "busy") return L"已有测速任务运行中。";
    if (reason == "no-targets" || reason == "network-stopped" || reason == "control-unavailable") return L"没有当前已连接且已授权的测速设备；不会自动连接。";
    if (reason == "closed") return L"测速服务已关闭。";
    if (reason == "helper-unavailable") return L"已有组网组件尚未就绪；测速不会自动启动它。";
    if (reason == "transport-failed") return L"测速传输中断，保留已经完成的测量。";
    if (reason == "deadline") return L"已达到测速时限。";
    if (reason == "target-changed") return L"目标或配对连接已改变，测速已停止。";
    if (reason == "helper-changed") return L"Bridge 组网组件已改变，测速已停止。";
    if (reason == "user-cancelled") return L"已取消本次测速。";
    return L"正在读取当前配对通道…";
}
inline Json Transfer(const Json& input) {
    if (!Integer(input, "receivedBytes", MaxBytes) || !Numeric(input, "durationMs", 35000).known ||
        !Numeric(input, "bytesPerSecond", static_cast<double>(MaxBytes) * 1000).known ||
        !input.contains("limitReached") || !input["limitReached"].is_boolean()) return Json();
    const auto completion = Text(input, "completion");
    if (completion != "complete" && completion != "partial" && completion != "failed") return Json();
    return {{"receivedBytes", input["receivedBytes"]}, {"durationMs", input["durationMs"]},
        {"bytesPerSecond", input["bytesPerSecond"]}, {"completion", completion}, {"limitReached", input["limitReached"]}};
}
inline Json Report(const Json& input) {
    if (!Integer(input, "v", 1) || input["v"] != 1 || !input.contains("completed") || !input["completed"].is_boolean() ||
        !Integer(input, "maximumSeconds", 35) || input["maximumSeconds"] != 35 ||
        !Integer(input, "maxBytesPerDirection", MaxBytes) || input["maxBytesPerDirection"] != MaxBytes) return Json();
    const auto role = Text(input, "targetRole"); if (role != "host" && role != "client") return Json();
    Json report = {{"v", 1}, {"completed", input["completed"]}, {"targetRole", role}, {"maximumSeconds", 35},
        {"maxBytesPerDirection", MaxBytes}, {"startedAtUtc", nullptr}, {"finishedAtUtc", nullptr}, {"stopReason", nullptr},
        {"latency", nullptr}, {"download", nullptr}, {"upload", nullptr}, {"notes", Json::array({
            "本测速只测 A 与 B 已配对的 Bridge 通道，不代表 B 的互联网出口或网站速度。",
            "下载指 B→A，上传指 A→B；两端均按 A 的方向显示。延迟是往返 RTT。",
            "Mbps 与 MB/s 均使用十进制，8 Mbps = 1 MB/s。未完成阶段不代表零速度。",
            "每方向最多 5 秒或 64 MiB，总测速数据最多 128 MiB；双方均需 1.1.9。"
        })}};
    for (const auto* key : {"startedAtUtc", "finishedAtUtc"}) {
        const auto stamp = Text(input, key, 40);
        if (stamp.size() >= 20 && stamp[10] == 'T' && stamp.back() == 'Z' && stamp.find_first_not_of("0123456789-:.TZ") == std::string::npos) report[key] = stamp;
    }
    const std::set<std::string> stops = {"busy", "unsupported", "model-busy", "cooldown", "network-stopped", "recovery-busy",
        "control-unavailable", "target-changed", "helper-changed", "deadline", "user-cancelled", "closed", "transport-failed"};
    if (const auto stop = Text(input, "stopReason"); stops.contains(stop)) report["stopReason"] = stop;
    for (const auto* key : {"download", "upload"}) if (input.contains(key)) report[key] = Transfer(input[key]);
    if (input.contains("latency")) {
        const auto& latency = input["latency"];
        if (latency.is_object() && latency.contains("samples") && latency["samples"].is_array() && latency["samples"].size() <= 5 &&
            Integer(latency, "failedSamples", 5) && latency["samples"].size() + latency["failedSamples"].get<unsigned>() <= 5) {
            std::vector<double> samples;
            for (const auto& value : latency["samples"]) if (value.is_number()) {
                const auto ms = value.get<double>(); if (std::isfinite(ms) && ms >= 0 && ms <= 35000) samples.push_back(ms);
            }
            if (samples.size() == latency["samples"].size()) {
                Json safe = {{"samples", samples}, {"minMs", nullptr}, {"medianMs", nullptr}, {"maxMs", nullptr}, {"failedSamples", latency["failedSamples"]}};
                if (!samples.empty()) {
                    std::sort(samples.begin(), samples.end()); const auto n = samples.size();
                    safe["minMs"] = samples.front(); safe["maxMs"] = samples.back(); safe["medianMs"] = n % 2 ? samples[n / 2] : (samples[n / 2 - 1] + samples[n / 2]) / 2;
                }
                report["latency"] = safe;
            }
        }
    }
    return report;
}
inline Number Speed(const Json& state, const Json& report, const char* direction) {
    const auto job = Job(state);
    const auto progress = job.is_object() && job.contains("progress") ? job["progress"] : Json();
    if (Running(state) && Text(progress, "phase") == direction) return Numeric(progress, "bytesPerSecond", static_cast<double>(MaxBytes) * 1000);
    if (report.is_object() && report.contains(direction) && Text(report[direction], "completion") != "failed")
        return Numeric(report[direction], "bytesPerSecond", static_cast<double>(MaxBytes) * 1000);
    return {};
}
inline Number Latency(const Json& state, const Json& report) {
    if (report.is_object() && report.contains("latency")) {
        const auto value = Numeric(report["latency"], "medianMs", 35000); if (value.known) return value;
    }
    const auto job = Job(state);
    return job.contains("progress") ? Numeric(job["progress"], "latencyMs", 35000) : Number{};
}
struct Progress { bool marquee = false; int position = 0; std::wstring text; };
inline Progress ViewProgress(const Json& state) {
    const auto job = Job(state), progress = job.contains("progress") ? job["progress"] : Json();
    const auto phase = Text(progress, "phase"), status = Text(job, "state");
    if (status == "completed") return {false, 1000, L"测速已完成。"};
    if (status == "cancelled") return {false, 0, L"测速已取消，保留已完成的测量。"};
    if (status == "failed") return {false, 0, L"测速未完成，请查看下方说明。"};
    if (status != "running") return {false, 0, Reason(state)};
    const auto label = phase == "latency" ? L"1/3 · 测量往返延迟" : phase == "download" ? L"2/3 · A 下载 B → A" : phase == "upload" ? L"3/3 · A 上传 A → B" : L"正在连接已配对通道";
    Progress view{true, 0, label};
    const auto elapsed = Numeric(progress, "elapsedMs", 35000), duration = Numeric(progress, "durationMs", 35000);
    const auto bytes = Numeric(progress, "bytes", MaxBytes), maximum = Numeric(progress, "maxBytes", MaxBytes);
    double fraction = -1;
    if (phase == "latency" && Integer(progress, "samplesDone", 5)) fraction = progress["samplesDone"].get<double>() / 5;
    if (phase == "download" || phase == "upload") {
        if (elapsed.known && duration.known && duration.value > 0) fraction = elapsed.value / duration.value;
        if (bytes.known && maximum.known && maximum.value > 0) fraction = std::max(fraction, bytes.value / maximum.value);
    }
    if (fraction >= 0) { view.marquee = false; view.position = static_cast<int>(std::clamp(fraction, 0.0, 1.0) * 1000); }
    if (elapsed.known) {
        std::wostringstream detail; detail << std::fixed << std::setprecision(1) << elapsed.value / 1000 << L" 秒";
        if (bytes.known) detail << L" · " << std::setprecision(2) << bytes.value / 1000000 << L" MB";
        view.text += L" · " + detail.str();
    }
    return view;
}
inline std::wstring Details(const Json& state, const Json& report) {
    std::wstring text = L"只测 A ↔ B 的 Bridge 通道，不代表 B 的外网速度。\r\n每方向 5 秒或 64 MiB；最多 128 MiB。Mbps 与 MB/s 为十进制。双方均需 1.1.9。";
    if (!report.is_object()) return text;
    if (report["startedAtUtc"].is_string()) text += L"\r\n开始 UTC：" + Wide(report["startedAtUtc"].get<std::string>());
    if (report["finishedAtUtc"].is_string()) text += L"\r\n结束 UTC：" + Wide(report["finishedAtUtc"].get<std::string>());
    for (const auto* key : {"download", "upload"}) if (report[key].is_object()) {
        const auto completion = Text(report[key], "completion");
        if (completion != "complete") text += key == std::string_view("download") ? L"\r\n下载阶段未完整完成。" : L"\r\n上传阶段未完整完成。";
    }
    if (report["stopReason"].is_string()) text += L"\r\n停止原因：" + Reason({{"reason", report["stopReason"]}});
    (void)state;
    return text;
}
}
