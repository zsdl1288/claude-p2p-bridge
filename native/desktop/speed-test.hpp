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
constexpr uint64_t MaxBytes = 268435456;
constexpr uint64_t MaximumMs = 60000;
constexpr uint64_t MaximumSamples = 64;
constexpr uint64_t AdaptiveUDPMaxBytes = 512 * 1024 * 1024;
constexpr uint64_t AdaptiveMaxBytes = 704 * 1024 * 1024;
constexpr uint64_t MultiTCPMaxBytes = 512 * 1024 * 1024;
constexpr uint64_t MultiMaxBytes = 1216 * 1024 * 1024;
constexpr uint64_t TCPStageMaxBytes = 192 * 1024 * 1024;
constexpr uint64_t TCPAdaptiveMaxBytes = 960 * 1024 * 1024;
constexpr uint64_t RampMaxBytes = 1472 * 1024 * 1024;
constexpr unsigned TCPConnectionCounts[] = {1, 2, 4, 8, 16};
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
    if (reason == "unsupported" || reason == "peer-unsupported") return L"双方均需升级至 1.2.11 或更新版，才能使用 TCP 低增幅提前停止测速。";
    if (reason == "model-busy") return L"模型任务正在执行或排队，请稍后测速。";
    if (reason == "recovery-busy") return L"Bridge 正在恢复通道，请稍后测速。";
    if (reason == "cooldown") return L"测速冷却中，每次开始至少间隔 15 秒。";
    if (reason == "busy") return L"已有测速任务运行中。";
    if (reason == "no-targets" || reason == "network-stopped" || reason == "control-unavailable") return L"没有当前已连接且已授权的测速设备；不会自动连接。";
    if (reason == "closed") return L"测速服务已关闭。";
    if (reason == "helper-unavailable") return L"已有组网组件尚未就绪；测速不会自动启动它。";
    if (reason == "transport-failed") return L"测速传输中断，保留已经完成的测量。";
    if (reason == "receiver-timeout") return L"等待接收端确认超时，保留已收到的测速数据。";
    if (reason == "deadline") return L"已达到测速时限。";
    if (reason == "target-changed") return L"目标或配对连接已改变，测速已停止。";
    if (reason == "helper-changed") return L"Bridge 组网组件已改变，测速已停止。";
    if (reason == "user-cancelled") return L"已取消本次测速。";
    return L"正在读取当前配对通道…";
}
inline Json Transfer(const Json& input, uint64_t maximum = MaxBytes, uint64_t maximumMs = MaximumMs) {
    if (!Integer(input, "receivedBytes", maximum) || !Numeric(input, "durationMs", maximumMs).known ||
        !Numeric(input, "bytesPerSecond", static_cast<double>(maximum) * 1000).known ||
        !input.contains("limitReached") || !input["limitReached"].is_boolean()) return Json();
    const auto completion = Text(input, "completion");
    if (completion != "complete" && completion != "partial" && completion != "failed") return Json();
    return {{"receivedBytes", input["receivedBytes"]}, {"durationMs", input["durationMs"]},
        {"bytesPerSecond", input["bytesPerSecond"]}, {"completion", completion}, {"limitReached", input["limitReached"]}};
}
inline Json MultiTransfer(const Json& input, unsigned connections = 4, uint64_t maximum = MultiTCPMaxBytes, uint64_t maximumMs = 150000) {
    const auto duration = Numeric(input, "durationMs", maximumMs);
    const auto completion = Text(input, "completion");
    if (!Integer(input, "receivedBytes", maximum) || !duration.known ||
        (completion != "complete" && completion != "partial" && completion != "failed") ||
        !input.contains("limitReached") || !input["limitReached"].is_boolean() ||
        !input.contains("streams") || !input["streams"].is_array() || input["streams"].size() != connections) return Json();
    Json streams = Json::array(); uint64_t received = 0;
    for (const auto& original : input["streams"]) {
        const auto elapsed = Numeric(original, "durationMs", duration.value);
        const auto status = Text(original, "completion");
        if (!Integer(original, "index", connections - 1) || original["index"] != streams.size() || !Integer(original, "receivedBytes", maximum) ||
            !elapsed.known || (elapsed.value == 0 && (original["receivedBytes"] != 0 || status == "complete")) ||
            (status != "complete" && status != "partial" && status != "failed") || (completion == "complete" && status != "complete") ||
            !original.contains("limitReached") || !original["limitReached"].is_boolean()) return Json();
        received += original["receivedBytes"].get<uint64_t>();
        streams.push_back({{"index", streams.size()}, {"receivedBytes", original["receivedBytes"]}, {"durationMs", elapsed.value},
            {"completion", status}, {"limitReached", original["limitReached"]}});
    }
    if (received > maximum || input["receivedBytes"] != received || (duration.value == 0 && (received != 0 || completion == "complete"))) return Json();
    return {{"receivedBytes", received}, {"durationMs", duration.value}, {"bytesPerSecond", duration.value > 0 ? Json(received * 1000.0 / duration.value) : Json()},
        {"completion", completion}, {"limitReached", input["limitReached"]}, {"streams", streams}};
}
inline Json AdaptiveTCP(const Json& input, bool earlyStop = false) {
    const auto completion = Text(input, "completion"), stop = Text(input, "stopReason");
    if ((completion != "complete" && completion != "partial" && completion != "failed") || !input.contains("stages") ||
        !input["stages"].is_array() || input["stages"].size() > 5 || !input.contains("stopReason") ||
        (!input["stopReason"].is_null() && stop != "completed" && stop != "cancelled" && stop != "failed" && !(earlyStop && stop == "plateau"))) return Json();
    Json stages = Json::array(), best = nullptr; uint64_t received = 0; unsigned lowGain = 0; int plateau = -1;
    for (const auto& original : input["stages"]) {
        const auto index = stages.size();
        if (!Integer(original, "index", 4) || original["index"] != index || !Integer(original, "connections", 16) ||
            original["connections"] != TCPConnectionCounts[index] || (index && Text(stages[index - 1], "completion") != "complete")) return Json();
        auto stage = MultiTransfer(original, TCPConnectionCounts[index], TCPStageMaxBytes, 210000);
        if (!stage.is_object()) return Json();
        stage["index"] = index; stage["connections"] = TCPConnectionCounts[index]; received += stage["receivedBytes"].get<uint64_t>();
        if (Text(stage, "completion") == "complete") {
            const double priorBest = best.is_null() ? 0 : stages[best.get<size_t>()]["bytesPerSecond"].get<double>();
            const double rate = stage["bytesPerSecond"].get<double>();
            lowGain = priorBest > 0 && rate * 100 < priorBest * 105 ? lowGain + 1 : 0;
            if (lowGain >= 2 && plateau < 0) plateau = static_cast<int>(index);
            if (best.is_null() || rate > priorBest) best = index;
        }
        stages.push_back(stage);
    }
    const bool allComplete = stages.size() == 5 && Text(stages.back(), "completion") == "complete";
    if (earlyStop) {
        if (plateau >= 0 && plateau < 4 && stages.size() > static_cast<size_t>(plateau + 1)) return Json();
        const bool plateauComplete = stages.size() >= 3 && stages.size() < 5 && Text(stages.back(), "completion") == "complete" && plateau == static_cast<int>(stages.size()) - 1;
        if ((completion == "complete" || stop == "completed" || stop == "plateau") &&
            !(completion == "complete" && ((stop == "completed" && allComplete) || (stop == "plateau" && plateauComplete)))) return Json();
    } else if ((completion == "complete" && (!allComplete || stop != "completed")) || (stop == "completed" && completion != "complete")) return Json();
    return {{"completion", completion}, {"stages", stages}, {"bestStageIndex", best}, {"totalReceivedBytes", received}, {"stopReason", stop.empty() ? Json() : Json(stop)}};
}
inline Json BestTCP(const Json& value) {
    if (!Integer(value, "bestStageIndex", 4) || !value.contains("stages") || !value["stages"].is_array()) return Json();
    const auto index = value["bestStageIndex"].get<size_t>(); return index < value["stages"].size() ? value["stages"][index] : Json();
}
inline Json UDPTransfer(const Json& input, bool adaptive = false) {
    const uint64_t maximum = adaptive ? AdaptiveUDPMaxBytes : 64 * 1024 * 1024;
    const bool pending = adaptive && Numeric(input, "durationMs", 120000).known && input["durationMs"] == 0 &&
        Integer(input, "receivedBytes", maximum) && input["receivedBytes"] == 0 && Text(input, "completion") == "partial";
    auto normalized = input;
    if (pending) normalized["bytesPerSecond"] = 0;
    auto value = Transfer(normalized, maximum, adaptive ? 120000 : MaximumMs);
    if (!value.is_object() || !Integer(input, "receivedBytes", maximum) ||
        !Numeric(input, "durationMs", adaptive ? 120000 : MaximumMs).known || (!pending && input["durationMs"].get<double>() == 0) ||
        !Integer(input, "packetBytes", 1200) || input["packetBytes"] == 0 ||
        !Integer(input, "receivedPackets", maximum) || !Integer(input, "duplicatePackets", maximum) ||
        !Integer(input, "outOfOrderPackets", maximum) || !Numeric(input, "offeredBytesPerSecond", adaptive ? 125000000 : 6250000).known) return Json();
    const bool confirmed = Integer(input, "sentPackets", maximum) && Integer(input, "sentBytes", maximum) &&
        input["sentPackets"].get<uint64_t>() >= input["receivedPackets"].get<uint64_t>() &&
        input["sentBytes"].get<uint64_t>() >= input["receivedBytes"].get<uint64_t>();
    if (!confirmed && Text(input, "completion") == "complete") return Json();
    const bool counted = confirmed && Integer(input, "lostPackets", maximum) && Numeric(input, "lossPercent", 100).known;
    value["bytesPerSecond"] = pending ? Json() : Json(input["receivedBytes"].get<double>() * 1000 / input["durationMs"].get<double>());
    for (const auto* key : {"receivedPackets", "duplicatePackets", "outOfOrderPackets", "offeredBytesPerSecond", "packetBytes"}) value[key] = input[key];
    value["sentBytes"] = confirmed ? input["sentBytes"] : Json(); value["sentPackets"] = confirmed ? input["sentPackets"] : Json();
    value["lostPackets"] = counted ? Json(input["sentPackets"].get<uint64_t>() - input["receivedPackets"].get<uint64_t>()) : Json();
    value["lossPercent"] = counted && input["sentPackets"].get<uint64_t>() > 0 ?
        Json(value["lostPackets"].get<double>() * 100 / input["sentPackets"].get<double>()) : Json();
    return value;
}
inline Json AdaptiveUDP(const Json& input) {
    const auto completion = Text(input, "completion"), reason = Text(input, "stopReason");
    const std::set<std::string> reasons = {"loss-limited", "sender-limited", "rate-ceiling", "byte-budget", "time-budget", "cancelled", "failed"};
    if (Text(input, "mode") != "adaptive" || (completion != "complete" && completion != "partial" && completion != "failed") ||
        !input.contains("stages") || !input["stages"].is_array() || input["stages"].size() > 16 ||
        !input.contains("stopReason") || (!input["stopReason"].is_null() && !reasons.contains(reason))) return Json();
    Json stages = Json::array(), best = nullptr, peak = nullptr;
    uint64_t sent = 0, received = 0;
    for (const auto& original : input["stages"]) {
        auto stage = UDPTransfer(original, true);
        const auto target = Numeric(original, "targetBytesPerSecond", 125000000);
        if (!stage.is_object() || !Integer(original, "index", 15) || original["index"] != stages.size() || !target.known || target.value < 31250 ||
            stage["packetBytes"] != 1100 || stage["offeredBytesPerSecond"] != target.value ||
            stage["receivedBytes"].get<uint64_t>() != stage["receivedPackets"].get<uint64_t>() * 1100 ||
            stage["outOfOrderPackets"].get<uint64_t>() > stage["receivedPackets"].get<uint64_t>()) return Json();
        const bool known = !stage["sentBytes"].is_null(), complete = Text(stage, "completion") == "complete";
        const auto senderDuration = Numeric(original, "senderDurationMs", 120000);
        if (known && (!senderDuration.known || senderDuration.value <= 0 || stage["sentBytes"].get<uint64_t>() != stage["sentPackets"].get<uint64_t>() * 1100)) return Json();
        if (complete && (!known || stage["lossPercent"].is_null())) return Json();
        const double senderRate = known ? stage["sentBytes"].get<double>() * 1000 / senderDuration.value : 0;
        const bool reached = known && senderRate >= target.value * 0.85;
        stage["index"] = stages.size(); stage["targetBytesPerSecond"] = target.value;
        stage["senderDurationMs"] = known ? Json(senderDuration.value) : Json(); stage["senderBytesPerSecond"] = known ? Json(senderRate) : Json();
        stage["targetReached"] = reached;
        stage["assessment"] = !complete ? "incomplete" : !reached ? "sender-limited" : stage["lossPercent"].get<double>() > 1 ? "loss-limited" : "passed";
        if (known) sent += stage["sentBytes"].get<uint64_t>();
        received += stage["receivedBytes"].get<uint64_t>();
        if (sent > AdaptiveUDPMaxBytes || received > AdaptiveUDPMaxBytes) return Json();
        if (complete) {
            if (peak.is_null() || stage["bytesPerSecond"].get<double>() > stages[peak.get<size_t>()]["bytesPerSecond"].get<double>()) peak = stages.size();
            if (stage["lossPercent"].get<double>() <= 1 && (best.is_null() || stage["bytesPerSecond"].get<double>() > stages[best.get<size_t>()]["bytesPerSecond"].get<double>())) best = stages.size();
        }
        stages.push_back(stage);
    }
    if (completion == "complete" && (peak.is_null() || reason.empty() || reason == "cancelled" || reason == "failed")) return Json();
    return {{"mode", "adaptive"}, {"completion", completion}, {"stages", stages}, {"lowLossStageIndex", best}, {"peakStageIndex", peak},
        {"stopReason", reason.empty() ? Json() : Json(reason)}, {"lowerBound", reason == "sender-limited" || reason == "rate-ceiling" || reason == "byte-budget" || reason == "time-budget"},
        {"totalSentBytes", sent}, {"totalReceivedBytes", received}, {"rateCeilingBytesPerSecond", 125000000}, {"lossThresholdPercent", 1}, {"minimumSenderRatio", 0.85}};
}
inline bool Native(const Json& state, const Json& report = Json()) {
    if (Text(report, "transport") == "native-tailscale" || Text(state, "transport") == "native-tailscale") return true;
    const auto job = Job(state);
    return job.contains("report") && Text(job["report"], "transport") == "native-tailscale";
}
inline bool Adaptive(const Json& state, const Json& report = Json()) {
    if (report.is_object() && report.contains("v")) return report["v"] == 3 || report["v"] == 4 || report["v"] == 5 || report["v"] == 6;
    const auto job = Job(state);
    if (job.contains("report") && job["report"].is_object() && job["report"].contains("v")) return job["report"]["v"] == 3 || job["report"]["v"] == 4 || job["report"]["v"] == 5 || job["report"]["v"] == 6;
    return Native(state);
}
inline bool Multi(const Json& state, const Json& report = Json()) {
    if (report.is_object() && report.contains("v")) return report["v"] == 4 || report["v"] == 5 || report["v"] == 6;
    const auto job = Job(state);
    if (job.contains("report") && job["report"].is_object() && job["report"].contains("v")) return job["report"]["v"] == 4 || job["report"]["v"] == 5 || job["report"]["v"] == 6;
    return Native(state);
}
inline bool Ramp(const Json& state, const Json& report = Json()) {
    if (report.is_object() && report.contains("v")) return report["v"] == 5 || report["v"] == 6;
    const auto job = Job(state);
    if (job.contains("report") && job["report"].is_object() && job["report"].contains("v")) return job["report"]["v"] == 5 || job["report"]["v"] == 6;
    return Native(state);
}
inline bool Plateau(const Json& state, const Json& report = Json()) {
    if (report.is_object() && report.contains("v")) return report["v"] == 6;
    const auto job = Job(state);
    if (job.contains("report") && job["report"].is_object() && job["report"].contains("v")) return job["report"]["v"] == 6;
    return Native(state);
}
inline Json Report(const Json& input) {
    if (!Integer(input, "v", 6) || input["v"] == 0 || !input.contains("completed") || !input["completed"].is_boolean()) return Json();
    const bool plateau = input["v"] == 6, adaptive = input["v"] >= 3, multi = input["v"] >= 4, ramp = input["v"] >= 5;
    const uint64_t seconds = ramp ? 210 : multi ? 150 : adaptive ? 120 : 60, bytes = ramp ? RampMaxBytes : multi ? MultiMaxBytes : adaptive ? AdaptiveMaxBytes : MaxBytes;
    if (!Integer(input, "maximumSeconds", seconds) || input["maximumSeconds"] != seconds ||
        !Integer(input, "maxBytesPerDirection", bytes) || input["maxBytesPerDirection"] != bytes) return Json();
    const auto role = Text(input, "targetRole"); if (role != "host" && role != "client") return Json();
    const bool native = input["v"] != 1;
    if (native && Text(input, "transport") != "native-tailscale") return Json();
    Json report = {{"v", input["v"]}, {"transport", native ? "native-tailscale" : "legacy-websocket"}, {"completed", input["completed"]}, {"targetRole", role}, {"maximumSeconds", seconds},
        {"maxBytesPerDirection", bytes}, {"startedAtUtc", nullptr}, {"finishedAtUtc", nullptr}, {"stopReason", nullptr},
        {"latency", nullptr}, {"download", nullptr}, {"upload", nullptr}, {"notes", Json::array({
            "本测速只测配对通道参考吞吐，不代表原生 TCP/UDP 代理、B 的互联网出口或网站速度。",
            "下载指 B→A，上传指 A→B；两端均按 A 的方向显示。延迟是往返 RTT。",
            "Mbps 与 MB/s 均使用十进制，8 Mbps = 1 MB/s。未完成阶段不代表零速度。",
            "每方向最多 20 秒或 256 MiB，总测速数据最多 512 MiB；双方均需 1.2.0。延迟在上传下载期间同步测量。"
        })}};
    if (native) {
        report["tcpMaxBytesPerDirection"] = 192 * 1024 * 1024; report["udpMaxBytesPerDirection"] = adaptive ? AdaptiveUDPMaxBytes : 64 * 1024 * 1024;
        report["tcpSecondsPerDirection"] = 10; report["udpSecondsPerDirection"] = adaptive ? 30 : 8;
        if (adaptive) report["udpBudgetIsSoft"] = true;
        report["udp"] = {{"download", nullptr}, {"upload", nullptr}};
        if (input.contains("udp") && input["udp"].is_object()) for (const auto* key : {"download", "upload"})
            if (input["udp"].contains(key)) report["udp"][key] = adaptive ? AdaptiveUDP(input["udp"][key]) : UDPTransfer(input["udp"][key]);
        report["notes"] = Json::array({
            "使用原生代理相同的 SOCKS、TCP/UDP 数据处理路径和固定合成源汇，不访问外部测速网站。",
            "下载指 B→A，上传指 A→B；吞吐按实际接收载荷计算。结果不含 B 互联网出口及 Clash TUN 开销。",
            "TCP 每方向最多 10 秒 / 192 MiB；UDP 每方向最多 8 秒 / 64 MiB；整组最长 60 秒、最多 512 MiB。",
            "UDP 使用 50 Mbps 目标发送负载，显示有效接收速率和实际发包数对应的丢包；不是 UDP 最大带宽。缺失确认保持未知。"
        });
        if (adaptive) report["notes"] = Json::array({
            "UDP 从 1 Mbps 起逐档加压；低丢包最佳取丢包不超过 1% 的完整确认档，峰值取所有完整确认档，两者可能不同。",
            "每档分别报告目标、实际发送、实际接收速率及丢包。发送器、时间、流量或最高测试档受限时仅为已测下界，不代表线路极限。",
            "TCP 每方向 10 秒 / 192 MiB；UDP 每方向 512 MiB、30 秒升档预算，收尾确认可延长；整组硬限 120 秒 / 1408 MiB。",
            "各档最多发送 1.5 秒，结果是本次短窗测量。丢包可能来自链路、代理或本机套接字；不含 B 互联网出口及 Clash TUN 开销。"
        });
        if (ramp) {
            report["tcpStageMaxBytes"] = TCPStageMaxBytes; report["tcpStageSeconds"] = 10;
            report["tcpMultiMaxBytesPerDirection"] = TCPAdaptiveMaxBytes; report["tcpMultiSecondsPerDirection"] = 50;
            const auto plan = Json::array({1, 2, 4, 8, 16});
            report["tcpMulti"] = {{"mode", "adaptive"}, {"connectionCounts", plan}, {"download", nullptr}, {"upload", nullptr}};
            const Json policy = {{"minimumGainPercent", 5}, {"consecutiveStages", 2}};
            if (plateau) report["tcpMulti"]["earlyStop"] = policy;
            if (input.contains("tcpMulti") && Text(input["tcpMulti"], "mode") == "adaptive" && input["tcpMulti"].contains("connectionCounts") && input["tcpMulti"]["connectionCounts"] == plan &&
                (!plateau || (input["tcpMulti"].contains("earlyStop") && Integer(input["tcpMulti"]["earlyStop"], "minimumGainPercent", 5) && input["tcpMulti"]["earlyStop"]["minimumGainPercent"] == 5 &&
                    Integer(input["tcpMulti"]["earlyStop"], "consecutiveStages", 2) && input["tcpMulti"]["earlyStop"]["consecutiveStages"] == 2)))
                for (const auto* key : {"download", "upload"}) if (input["tcpMulti"].contains(key)) report["tcpMulti"][key] = AdaptiveTCP(input["tcpMulti"][key], plateau);
            report["notes"][2] = "TCP 按 1、2、4、8、16 条连接逐档测量，每档共享 10 秒 / 192 MiB；以共同窗口总实收字节计算速率，单连接复用第一档，已包含在五档预算内。";
            if (plateau) report["notes"].push_back("完整档相比此前最佳实收速率连续两次提升不足 5% 即提前结束，至少测三档；达到 5% 则重置，满五档优先正常完成。最高速度仍取所有已确认档的真实最大值。");
            report["notes"].push_back("最高值仅选完整确认档，相同速率优先更少连接；每方向 TCP 960 MiB、UDP 512 MiB，整组硬限 210 秒 / 2944 MiB（约 2.88 GiB）。本次已测最高值不代表物理带宽或全局最优连接数。");
        } else if (multi) {
            report["tcpMultiMaxBytesPerDirection"] = MultiTCPMaxBytes; report["tcpMultiSecondsPerDirection"] = 10;
            report["tcpMulti"] = {{"connections", 4}, {"download", nullptr}, {"upload", nullptr}};
            if (input.contains("tcpMulti") && Integer(input["tcpMulti"], "connections", 4) && input["tcpMulti"]["connections"] == 4)
                for (const auto* key : {"download", "upload"}) if (input["tcpMulti"].contains(key)) report["tcpMulti"][key] = MultiTransfer(input["tcpMulti"][key]);
            report["notes"][2] = "TCP 单连接与四连接依次测量，上下行各最多 10 秒；单连接每向 192 MiB，四连接共享每向 512 MiB，按总实收字节和共同墙钟时间计算速率。";
            report["notes"].push_back("UDP 每向 512 MiB、30 秒升档预算；整组硬限 150 秒 / 2432 MiB（约 2.38 GiB）。四连接用于比较通道吞吐，不保证跑满物理线路。");
        }
    }
    for (const auto* key : {"startedAtUtc", "finishedAtUtc"}) {
        const auto stamp = Text(input, key, 40);
        if (stamp.size() >= 20 && stamp[10] == 'T' && stamp.back() == 'Z' && stamp.find_first_not_of("0123456789-:.TZ") == std::string::npos) report[key] = stamp;
    }
    const std::set<std::string> stops = {"busy", "unsupported", "model-busy", "cooldown", "network-stopped", "recovery-busy",
        "control-unavailable", "target-changed", "helper-changed", "deadline", "user-cancelled", "closed", "transport-failed", "receiver-timeout"};
    if (const auto stop = Text(input, "stopReason"); stops.contains(stop)) report["stopReason"] = stop;
    for (const auto* key : {"download", "upload"}) if (input.contains(key)) {
        report[key] = Transfer(input[key]);
        if (native && report[key].is_object()) {
            if (!Integer(input[key], "receivedBytes", 192 * 1024 * 1024) || input[key]["durationMs"].get<double>() <= 0) report[key] = nullptr;
            else report[key]["bytesPerSecond"] = input[key]["receivedBytes"].get<double>() * 1000 / input[key]["durationMs"].get<double>();
        }
    }
    if (ramp) for (const auto* key : {"download", "upload"}) {
        const auto& direction = report["tcpMulti"][key]; report[key] = nullptr;
        if (direction.is_object() && !direction["stages"].empty()) {
            const auto& first = direction["stages"][0];
            if (first["durationMs"].get<double>() > 0) report[key] = Transfer(first, TCPStageMaxBytes, 210000);
        }
    }
    if (input.contains("latency")) {
        const auto& latency = input["latency"];
        if (latency.is_object() && latency.contains("samples") && latency["samples"].is_array() && latency["samples"].size() <= MaximumSamples &&
            Integer(latency, "failedSamples", MaximumSamples) && latency["samples"].size() + latency["failedSamples"].get<unsigned>() <= MaximumSamples) {
            std::vector<double> samples;
            for (const auto& value : latency["samples"]) if (value.is_number()) {
                const auto ms = value.get<double>(); if (std::isfinite(ms) && ms >= 0 && ms <= MaximumMs) samples.push_back(ms);
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
    if (multi && report["completed"] == true) for (const auto* key : {"download", "upload"})
        if (Text(report[key], "completion") != "complete" || Text(report["tcpMulti"][key], "completion") != "complete" || Text(report["udp"][key], "completion") != "complete") report["completed"] = false;
    return report;
}
inline Number Speed(const Json& state, const Json& report, const char* direction) {
    const auto job = Job(state);
    const auto progress = job.is_object() && job.contains("progress") ? job["progress"] : Json();
    if (Running(state) && Text(progress, "phase") == direction) {
        const auto live = Numeric(progress, "bytesPerSecond", static_cast<double>(MaxBytes) * 1000); if (live.known) return live;
    }
    if (report.is_object() && report.contains(direction) && Text(report[direction], "completion") != "failed")
        return Numeric(report[direction], "bytesPerSecond", static_cast<double>(MaxBytes) * 1000);
    return {};
}
inline Number MultiSpeed(const Json& state, const Json& report, const char* direction) {
    const auto job = Job(state), progress = job.contains("progress") ? job["progress"] : Json();
    if (!Ramp(state, report) && Running(state) && Text(progress, "phase") == std::string("multi-") + direction) {
        const auto rate = Numeric(progress, "bytesPerSecond", static_cast<double>(MultiTCPMaxBytes) * 1000); if (rate.known) return rate;
    }
    auto metric = report.is_object() && report.contains("tcpMulti") && report["tcpMulti"].contains(direction) ? report["tcpMulti"][direction] : Json();
    if (Ramp(state, report)) metric = BestTCP(metric);
    return Text(metric, "completion") == "failed" ? Number{} : Numeric(metric, "bytesPerSecond", static_cast<double>(MultiTCPMaxBytes) * 1000);
}
inline std::wstring MultiComparison(const Json& report, const char* direction) {
    if (!report.is_object() || !report.contains(direction) || !report.contains("tcpMulti") || !report["tcpMulti"].contains(direction)) return L"";
    const auto single = report[direction], multi = Ramp(Json(), report) ? BestTCP(report["tcpMulti"][direction]) : report["tcpMulti"][direction];
    const auto a = Numeric(single, "bytesPerSecond", static_cast<double>(MaxBytes) * 1000), b = Numeric(multi, "bytesPerSecond", static_cast<double>(MultiTCPMaxBytes) * 1000);
    if (Text(single, "completion") != "complete" || Text(multi, "completion") != "complete" || !a.known || !b.known || a.value <= 0) return L"";
    std::wostringstream text; text << std::fixed << std::setprecision(2) << b.value / a.value; return L"单连接的 " + text.str() + L" 倍";
}
inline std::wstring MultiLabel(const Json& state, const Json& report, const char* direction) {
    const auto job = Job(state), progress = job.contains("progress") ? job["progress"] : Json();
    if (Ramp(state, report)) {
        const auto value = report.is_object() && report.contains("tcpMulti") && report["tcpMulti"].contains(direction) ? report["tcpMulti"][direction] : Json();
        const auto best = BestTCP(value);
        if (!best.is_object()) return L"等待完整档位确认";
        const auto label = std::to_wstring(best["connections"].get<unsigned>()) + L" 条连接";
        if (Plateau(state, report) && Text(value, "completion") == "complete" && Text(value, "stopReason") == "plateau")
            return std::to_wstring(best["connections"].get<unsigned>()) + L"连接 · 提前结束" + std::to_wstring(value["stages"].size()) + L"/5";
        return label + (Text(value, "completion") == "complete" ? L" · 五档完成" : L" · 尚未测完");
    }
    if (Running(state) && Text(progress, "phase") == std::string("multi-") + direction) return L"测速中";
    const auto metric = report.is_object() && report.contains("tcpMulti") && report["tcpMulti"].contains(direction) ? report["tcpMulti"][direction] : Json();
    if (Text(metric, "completion") == "partial") return L"部分结果";
    if (Text(metric, "completion") == "failed") return L"未完成";
    return MultiComparison(report, direction);
}
inline Number Latency(const Json& state, const Json& report) {
    const auto job = Job(state);
    if (Running(state) && job.contains("progress")) {
        const auto live = Numeric(job["progress"], "latencyMs", MaximumMs); if (live.known) return live;
    }
    if (report.is_object() && report.contains("latency")) return Numeric(report["latency"], "medianMs", MaximumMs);
    return {};
}
inline std::wstring SamplesLabel(const Json& state, const Json& report) {
    std::wstring label = L"传输中 RTT · 中位数";
    const auto job = Job(state), progress = job.contains("progress") ? job["progress"] : Json();
    if (Running(state) && Integer(progress, "samplesDone", MaximumSamples)) return label + L"\r\n" + std::to_wstring(progress["samplesDone"].get<unsigned>()) + L" 个样本";
    if (report.is_object() && report.contains("latency") && report["latency"].is_object() && report["latency"].contains("samples") && report["latency"]["samples"].is_array())
        label += L"\r\n" + std::to_wstring(report["latency"]["samples"].size()) + L" 个样本";
    return label;
}
struct Progress { bool marquee = false; int position = 0; std::wstring text; };
inline Progress ViewProgress(const Json& state) {
    const auto job = Job(state), progress = job.contains("progress") ? job["progress"] : Json();
    const auto phase = Text(progress, "phase"), status = Text(job, "state");
    if (status == "completed") return {false, 1000, L"测速已完成。"};
    if (status == "cancelled") return {false, 0, L"测速已取消，保留已完成的测量。"};
    if (status == "failed") return {false, 0, L"测速未完成，请查看下方说明。"};
    if (status != "running") return {false, 0, Reason(state)};
    const bool native = Native(state), multi = Multi(state), ramp = Ramp(state);
    const auto label = ramp ? (phase == "multi-download" ? L"1/4 · TCP 逐档 · A 下载 B → A" : phase == "multi-upload" ? L"2/4 · TCP 逐档 · A 上传 A → B" :
        phase == "udp-download" ? L"3/4 · UDP · A 下载 B → A" : phase == "udp-upload" ? L"4/4 · UDP · A 上传 A → B" : L"正在连接已配对通道") : multi ? (phase == "download" ? L"1/6 · TCP 单连接 · A 下载 B → A" : phase == "upload" ? L"2/6 · TCP 单连接 · A 上传 A → B" :
        phase == "multi-download" ? L"3/6 · TCP 四连接 · A 下载 B → A" : phase == "multi-upload" ? L"4/6 · TCP 四连接 · A 上传 A → B" :
        phase == "udp-download" ? L"5/6 · UDP · A 下载 B → A" : phase == "udp-upload" ? L"6/6 · UDP · A 上传 A → B" : L"正在连接已配对通道") : phase == "download" ? (native ? L"1/4 · TCP · A 下载 B → A" : L"1/2 · A 下载 B → A") :
        phase == "upload" ? (native ? L"2/4 · TCP · A 上传 A → B" : L"2/2 · A 上传 A → B") :
        phase == "udp-download" ? L"3/4 · UDP · A 下载 B → A" : phase == "udp-upload" ? L"4/4 · UDP · A 上传 A → B" : L"正在连接已配对通道";
    Progress view{true, 0, label};
    const bool adaptive = Adaptive(state);
    const auto elapsed = Numeric(progress, "elapsedMs", ramp ? 210000 : multi ? 150000 : adaptive ? 120000 : MaximumMs), duration = Numeric(progress, "durationMs", ramp ? 210000 : multi ? 150000 : adaptive ? 120000 : MaximumMs);
    const auto bytes = Numeric(progress, "bytes", ramp ? RampMaxBytes : multi ? MultiMaxBytes : adaptive ? AdaptiveMaxBytes : MaxBytes), maximum = Numeric(progress, "maxBytes", ramp ? RampMaxBytes : multi ? MultiMaxBytes : adaptive ? AdaptiveMaxBytes : MaxBytes);
    const bool transfer = phase == "download" || phase == "upload" || (native && (phase == "udp-download" || phase == "udp-upload")) || (multi && (phase == "multi-download" || phase == "multi-upload"));
    const bool confirming = transfer && progress.contains("waitingForReceiver") && progress["waitingForReceiver"] == true;
    double fraction = -1;
    if (transfer && !confirming) {
        if (elapsed.known && duration.known && duration.value > 0) fraction = elapsed.value / duration.value;
        if (bytes.known && maximum.known && maximum.value > 0) fraction = std::max(fraction, bytes.value / maximum.value);
    }
    // A receiver confirmation is still pending after sending has stopped;
    // reserve 100% exclusively for a completed, confirmed whole test.
    if (fraction >= 0) {
        const double step = 1000.0 / (ramp ? 4 : multi ? 6 : native ? 4 : 2);
        const int index = ramp ? (phase == "multi-upload" ? 1 : phase == "udp-download" ? 2 : phase == "udp-upload" ? 3 : 0) : phase == "upload" ? 1 : phase == "multi-download" ? 2 : phase == "multi-upload" ? 3 : phase == "udp-download" ? (multi ? 4 : 2) : phase == "udp-upload" ? (multi ? 5 : 3) : 0;
        double part = std::clamp(fraction, 0.0, 0.98);
        if (ramp && (phase == "multi-download" || phase == "multi-upload") && Integer(progress, "stageIndex", 4)) part = (progress["stageIndex"].get<unsigned>() + part) / 5;
        view.marquee = false; view.position = static_cast<int>((index + part) * step);
    }
    if (confirming) {
        view.text += L" · 正在等待接收端确认";
        const auto remaining = Numeric(progress, "confirmationRemainingMs", 5000);
        if (remaining.known) { std::wostringstream detail; detail << std::fixed << std::setprecision(1) << remaining.value / 1000; view.text += L"（最多 " + detail.str() + L" 秒）"; }
    } else if (elapsed.known) {
        std::wostringstream detail; detail << std::fixed << std::setprecision(1) << elapsed.value / 1000;
        if (transfer && duration.known && duration.value > 0) detail << L" / " << duration.value / 1000;
        detail << L" 秒";
        if (bytes.known && transfer) detail << L" · 已接收 " << std::setprecision(2) << bytes.value / 1000000 << L" MB";
        view.text += L" · " + detail.str();
    }
    if (adaptive && (phase == "udp-download" || phase == "udp-upload") && Integer(progress, "stageIndex", 15)) {
        view.text += L" · 第 " + std::to_wstring(progress["stageIndex"].get<unsigned>() + 1) + L" 档";
        view.text += L" · 目标 " + Rate(Numeric(progress, "targetBytesPerSecond", 125000000));
        view.text += L" · 实发 " + Rate(Numeric(progress, "senderBytesPerSecond", static_cast<double>(AdaptiveUDPMaxBytes) * 1000));
    }
    if (ramp && (phase == "multi-download" || phase == "multi-upload") && Integer(progress, "stageIndex", 4)) {
        const auto index = progress["stageIndex"].get<unsigned>();
        view.text += L" · 第 " + std::to_wstring(index + 1) + L"/5 档 · " + std::to_wstring(TCPConnectionCounts[index]) + L" 条连接";
        view.text += L" · 实收 " + Rate(Numeric(progress, "bytesPerSecond", static_cast<double>(TCPStageMaxBytes) * 1000));
    }
    return view;
}
inline std::wstring UDPStop(const std::string& reason) {
    if (reason == "loss-limited") return L"出现超过 1% 的丢包";
    if (reason == "sender-limited") return L"发送端未达到目标速率，仅为已测下界";
    if (reason == "rate-ceiling") return L"达到 1 Gbps 测试上限，仅为已测下界";
    if (reason == "byte-budget") return L"达到流量上限，仅为已测下界";
    if (reason == "time-budget") return L"达到测试时限，仅为已测下界";
    if (reason == "cancelled") return L"已取消，保留已完成档位";
    if (reason == "failed") return L"测量未完成";
    return L"正在逐级探测";
}
inline std::wstring Loss(const Json& stage) {
    const auto loss = Numeric(stage, "lossPercent", 100);
    if (!loss.known) return L"待确认";
    std::wostringstream text; text << std::fixed << std::setprecision(2) << loss.value; return text.str() + L"%";
}
inline Json UDPStage(const Json& udp, const char* key) {
    if (!Integer(udp, key, 15) || !udp.contains("stages") || !udp["stages"].is_array()) return Json();
    const auto index = udp[key].get<size_t>(); return index < udp["stages"].size() ? udp["stages"][index] : Json();
}
inline std::wstring AdaptiveDetails(const Json& report, bool multi = false, bool ramp = false) {
    std::wstring text = L"UDP 自适应测速 · 本次短窗实测（低丢包阈值 1%）";
    for (const auto* key : {"download", "upload"}) {
        const auto udp = report.is_object() && report.contains("udp") && report["udp"].contains(key) ? report["udp"][key] : Json();
        const auto best = UDPStage(udp, "lowLossStageIndex"), peak = UDPStage(udp, "peakStageIndex");
        text += key == std::string_view("download") ? L"\r\n\r\nUDP 下载 B→A：" : L"\r\n\r\nUDP 上传 A→B：";
        if (best.is_object()) text += L"低丢包最佳 " + Rate(Numeric(best, "bytesPerSecond", static_cast<double>(AdaptiveUDPMaxBytes) * 1000)) + L" · 丢包 " + Loss(best);
        else text += L"暂无已确认的低丢包档";
        if (peak.is_object()) text += L"\r\n峰值 " + Rate(Numeric(peak, "bytesPerSecond", static_cast<double>(AdaptiveUDPMaxBytes) * 1000)) + L" · 对应丢包 " + Loss(peak);
        text += L"\r\n" + UDPStop(Text(udp, "stopReason"));
    }
    text += L"\r\n\r\n逐级明细（目标 / 实发 / 实收；单位 Mbps）";
    for (const auto* key : {"download", "upload"}) {
        const auto udp = report.is_object() && report.contains("udp") && report["udp"].contains(key) ? report["udp"][key] : Json();
        text += key == std::string_view("download") ? L"\r\nA 下载 B→A" : L"\r\nA 上传 A→B";
        if (!udp.is_object() || !udp.contains("stages")) { text += L"：等待测量"; continue; }
        for (const auto& stage : udp["stages"]) {
            text += L"\r\n" + std::to_wstring(stage["index"].get<unsigned>() + 1) + L". " +
                Rate(Numeric(stage, "targetBytesPerSecond", 125000000)) + L" / " +
                Rate(Numeric(stage, "senderBytesPerSecond", static_cast<double>(AdaptiveUDPMaxBytes) * 1000)) + L" / " +
                Rate(Numeric(stage, "bytesPerSecond", static_cast<double>(AdaptiveUDPMaxBytes) * 1000)) + L" · 丢包 " + Loss(stage);
            if (Text(stage, "completion") != "complete") text += L" · 未完成";
        }
    }
    return text + L"\r\n\r\n从 1 Mbps 起逐档加压，最高测试 1 Gbps。UDP 每方向 512 MiB、30 秒升档预算，收尾确认可延长；" +
        (ramp ? L"整组硬限 210 秒 / 2944 MiB（约 2.88 GiB）。" : multi ? L"整组硬限 150 秒 / 2432 MiB（约 2.38 GiB）。" : L"整组硬限 120 秒 / 1408 MiB（约 1.38 GiB）。") +
        L"\r\n发送受限、时间/流量上限和最高测试档不代表线路极限；丢包可能来自链路、代理处理或本机套接字。不含 B 互联网出口及 Clash TUN 开销。";
}
inline std::wstring Details(const Json& state, const Json& report) {
    std::wstring text = L"只测配对通道参考吞吐，不代表原生 TCP/UDP 代理或 B 的外网速度。\r\n每方向 20 秒或 256 MiB；最多 512 MiB。延迟与传输同时测量。Mbps 与 MB/s 为十进制。双方均需 1.2.0。";
    if (Ramp(state, report)) {
        text = L"TCP 按 1、2、4、8、16 条连接逐档测量 · 已测最高速度及对应连接数";
        for (const auto* key : {"download", "upload"}) {
            const auto value = report.is_object() && report.contains("tcpMulti") && report["tcpMulti"].contains(key) ? report["tcpMulti"][key] : Json();
            const auto best = BestTCP(value);
            text += key == std::string_view("download") ? L"\r\n\r\nA 下载 B→A：" : L"\r\n\r\nA 上传 A→B：";
            if (best.is_object()) text += Rate(Numeric(best, "bytesPerSecond", static_cast<double>(TCPStageMaxBytes) * 1000)) + L" · " + std::to_wstring(best["connections"].get<unsigned>()) + L" 条连接 · " + MultiComparison(report, key);
            else text += L"等待完整确认档";
            if (Plateau(state, report) && Text(value, "completion") == "complete" && Text(value, "stopReason") == "plateau")
                text += L"\r\n提升不足提前结束 · 已测 " + std::to_wstring(value["stages"].size()) + L"/5 档（连续两档提升不足 5%）";
            else if (Text(value, "completion") != "complete") text += L" · 尚未完成全部档位";
            if (value.is_object()) for (const auto& stage : value["stages"]) {
                text += L"\r\n  " + std::to_wstring(stage["connections"].get<unsigned>()) + L" 条连接：" + Rate(Numeric(stage, "bytesPerSecond", static_cast<double>(TCPStageMaxBytes) * 1000));
                text += Text(stage, "completion") == "complete" ? L" · 已确认" : L" · 部分结果";
                if (stage["limitReached"] == true) text += L" · 达到该档流量上限";
            }
        }
        if (Plateau(state, report)) text += L"\r\n\r\n完整档相比此前最佳实收速率，连续两次提升不足 5% 即提前结束（下降或持平也计入）；至少测三档，达到 5% 则重置。满五档优先正常完成。";
        text += L"\r\n\r\n每档合计最多发送 10 秒 / 192 MiB，同一接收窗口计算实收总吞吐；单连接复用第 1 档。每方向最多五档合计 960 MiB，最高值只取完整确认档，相同速率优先更少连接。已测最高值不代表线路极限或全局最优连接数。\r\n\r\n" + AdaptiveDetails(report, true, true);
    }
    else if (Multi(state, report)) {
        text = L"TCP 单连接 / 四连接对比 · 按同一窗口总实收字节计算四连接速度";
        for (const auto* key : {"download", "upload"}) {
            const auto metric = report.is_object() && report.contains("tcpMulti") && report["tcpMulti"].contains(key) ? report["tcpMulti"][key] : Json();
            text += key == std::string_view("download") ? L"\r\nA 下载 B→A：" : L"\r\nA 上传 A→B：";
            text += L"单连接 " + Rate(Speed(state, report, key)) + L" / 四连接 " + Rate(MultiSpeed(state, report, key));
            const auto comparison = MultiComparison(report, key); if (!comparison.empty()) text += L" · " + comparison;
            if (Text(metric, "completion") == "partial") text += L" · 四连接部分结果";
            if (metric.is_object() && metric.contains("limitReached") && metric["limitReached"] == true) text += L" · 已达四连接合计流量上限";
        }
        text += L"\r\n每种 TCP 模式、每方向最多 10 秒；单连接 192 MiB，四连接合计 512 MiB。四路全部就绪后开始；短时结果用于比较，不保证跑满物理线路。\r\n\r\n" + AdaptiveDetails(report, true);
    }
    else if (Adaptive(state, report)) text = AdaptiveDetails(report);
    else if (Native(state, report)) {
        text = L"UDP · 目标发送负载 50 Mbps，不代表最大带宽。";
        for (const auto* key : {"download", "upload"}) {
            const auto udp = report.is_object() && report.contains("udp") && report["udp"].contains(key) ? report["udp"][key] : Json();
            const auto rate = Text(udp, "completion") == "failed" ? Number{} : Numeric(udp, "bytesPerSecond", static_cast<double>(MaxBytes) * 1000);
            text += key == std::string_view("download") ? L"\r\nUDP 下载 B→A：" : L"\r\nUDP 上传 A→B：";
            text += Rate(rate) + L" · 丢包 ";
            const auto loss = Numeric(udp, "lossPercent", 100);
            if (loss.known) { std::wostringstream amount; amount << std::fixed << std::setprecision(2) << loss.value; text += amount.str() + L"%"; }
            else text += L"待确认";
            if (Text(udp, "completion") == "partial") text += L" · 部分结果";
        }
        text += L"\r\n\r\n原生代理路径测速，不含 B 互联网出口及 Clash TUN 开销。\r\nTCP 每方向 10 秒 / 192 MiB；UDP 每方向 8 秒 / 64 MiB。整组最长 60 秒、最多 512 MiB。包数明细可导出 JSON 查看。";
    }
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
