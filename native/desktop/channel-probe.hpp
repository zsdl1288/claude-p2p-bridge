#pragma once
#include "platform.hpp"
#include <cmath>
#include <condition_variable>
#include <set>

namespace DesktopChannelProbe {
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
inline std::vector<Json> Targets(const Json& response) {
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
inline std::wstring Reason(const Json& state) {
    const auto reason = Text(state, "reason");
    if (reason == "ready") return L"请选择当前已配对的设备，然后手动探测。";
    if (reason == "busy") return L"本机已有探测任务运行中。";
    if (reason == "cooldown") return L"探测冷却中，请稍后再试。";
    if (reason == "model-busy") return L"模型任务正在执行或排队，请稍后再探测。";
    if (reason == "recovery-busy") return L"Bridge 正在恢复通道，请稍后再探测。";
    if (reason == "network-stopped") return L"私有网络已停止，探测不会自动连接。";
    if (reason == "no-targets") return L"当前没有可探测的已配对在线设备。";
    if (reason == "closed") return L"探测服务已关闭。";
    if (reason == "unsupported") return L"当前模式不支持通道探测。";
    if (reason == "helper-unavailable") return L"已有组网组件尚未就绪，探测不会启动它。";
    return L"正在读取当前配对通道的探测状态…";
}
inline bool CanStart(const Json& state) {
    return state.is_object() && state.contains("available") && state["available"] == true && state.contains("busy") && state["busy"] == false &&
        Integer(state, "retryAfterMs", 60000) && state["retryAfterMs"].get<uint64_t>() == 0 && !Targets(state).empty() && !Running(state);
}

// Export only the public report schema. Never serialize target selectors,
// addresses, endpoints, job/session IDs, API state, or authentication material.
inline Json Report(const Json& input) {
    if (!input.is_object() || !Integer(input, "v", 1) || input["v"] != 1 ||
        !input.contains("completed") || !input["completed"].is_boolean() ||
        !Integer(input, "plannedProbes", 9) || input["plannedProbes"] != 9 ||
        !Integer(input, "maximumSeconds", 35) || input["maximumSeconds"] != 35 ||
        !Integer(input, "completedProbes", 9) || !Integer(input, "replies", 9) ||
        input["replies"].get<uint64_t>() > input["completedProbes"].get<uint64_t>() ||
        !input.contains("results") || !input["results"].is_array() || input["results"].size() > 9) return Json();
    const auto role = Text(input, "targetRole");
    if (role != "client" && role != "host") return Json();
    Json report = {{"v", 1}, {"completed", input["completed"]}, {"targetRole", role},
        {"plannedProbes", 9}, {"completedProbes", input["completedProbes"]}, {"replies", input["replies"]},
        {"maximumSeconds", 35}, {"helperUnchanged", input.contains("helperUnchanged") && input["helperUnchanged"] == true},
        {"startedAtUtc", nullptr}, {"finishedAtUtc", nullptr}, {"stopReason", nullptr},
        {"results", Json::array()}, {"notes", Json::array({
            "TSMP 使用固定 29 字节内部 IPv4 包，实际路径未知，不能用于验证大包 MTU。",
            "disco 的 128/1200 字节指包含协议头的 UDP 载荷，不代表 WireGuard 大流量或下载测速。",
            "disco 可能主动发现并刷新节点路径；本探测不修改配对、系统网络设置或自动恢复策略。",
            "超时表示 2.5 秒内没有获得探测回复，不是单向丢包率或网站服务故障的证明。",
            "completed 仅表示固定探测计划执行完成，不代表网络健康。报告不包含设备名称或网络地址。"
        })}};
    for (const auto* key : {"startedAtUtc", "finishedAtUtc"}) {
        const auto stamp = Text(input, key, 40);
        if (stamp.size() >= 20 && stamp[10] == 'T' && stamp.back() == 'Z' &&
            stamp.find_first_not_of("0123456789-:.TZ") == std::string::npos) report[key] = stamp;
    }
    const std::set<std::string> stops = {"user-cancelled", "closed", "deadline", "model-busy", "network-stopped", "recovery-busy",
        "helper-changed", "target-changed", "rpc-unavailable", "probe-busy", "probe-group-failed"};
    if (const auto stop = Text(input, "stopReason"); stops.contains(stop)) report["stopReason"] = stop;
    const std::set<std::string> outcomes = {"reply", "timeout", "cancelled", "busy", "unavailable", "probe-error", "invalid-request", "invalid-result", "rpc-gap"};
    for (const auto& row : input["results"]) {
        const auto type = Text(row, "type"), outcome = Text(row, "outcome");
        if ((type != "TSMP" && type != "disco") || !Integer(row, "size", 1200)) continue;
        const auto size = row["size"].get<uint64_t>();
        if ((type == "TSMP" && size != 0) || (type == "disco" && size != 128 && size != 1200)) continue;
        const auto path = Text(row, "actualVia");
        Json result = {{"type", type}, {"size", size}, {"outcome", outcomes.contains(outcome) ? outcome : "invalid-result"},
            {"actualVia", type != "TSMP" && (path == "direct" || path == "derp" || path == "peer-relay") ? path : "unknown"}};
        if (outcome == "reply" && row.contains("latencySeconds") && row["latencySeconds"].is_number()) {
            const auto seconds = row["latencySeconds"].get<double>();
            if (std::isfinite(seconds) && seconds >= 0 && seconds <= 35) result["latencySeconds"] = seconds;
        }
        if (result["actualVia"] == "derp" && Integer(row, "derpRegionId", 65535) && row["derpRegionId"] != 0) {
            result["derpRegionId"] = row["derpRegionId"];
            const auto code = Text(row, "derpRegionCode", 16);
            if (!code.empty() && code.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-") == std::string::npos) result["derpRegionCode"] = code;
        }
        report["results"].push_back(std::move(result));
    }
    return report;
}
inline std::wstring Format(const Json& state, const Json& safeReport) {
    std::wstring text = L"发送少量探测包，可能更新 Bridge 路径；不是带宽测速。\r\n";
    text += L"仅探测当前已配对通道，不修改配对、Clash、TUN、系统代理或路由。\r\n";
    const auto job = Job(state);
    const auto phase = Text(job, "state");
    text += L"\r\n" + (phase == "running" ? std::wstring(L"正在探测（最多 35 秒）…") : phase == "cancelled" ? L"探测已取消。" :
        phase == "failed" ? L"本次探测未完成。" : phase == "completed" ? L"探测已结束。" : Reason(state));
    if (!safeReport.is_object()) return text;
    text += L"\r\n开始 UTC：" + Wide(safeReport["startedAtUtc"].is_string() ? safeReport["startedAtUtc"].get<std::string>() : "—");
    text += L"\r\n结束 UTC：" + Wide(safeReport["finishedAtUtc"].is_string() ? safeReport["finishedAtUtc"].get<std::string>() : "—");
    text += L"\r\n已完成：" + std::to_wstring(safeReport["completedProbes"].get<unsigned>()) + L" / 9；收到回复：" + std::to_wstring(safeReport["replies"].get<unsigned>());
    text += L"\r\n超时表示限时内未收到回复，回复数量不能当作真实公网丢包率。\r\n";
    for (const auto& row : safeReport["results"]) {
        const auto type = row["type"].get<std::string>(), outcome = row["outcome"].get<std::string>(), path = row["actualVia"].get<std::string>();
        const auto label = outcome == "reply" ? L"回复" : outcome == "timeout" ? L"超时" : outcome == "busy" ? L"组件忙" : outcome == "cancelled" ? L"已取消" : L"不可用";
        const auto route = path == "direct" ? L"直连" : path == "derp" ? L"DERP 中继" : path == "peer-relay" ? L"节点中继" : L"路径未知";
        text += L"\r\n" + Wide(type) + (type == "disco" ? L" " + std::to_wstring(row["size"].get<unsigned>()) : L" 小包") + L"：" + label + L" · " + route;
        if (row.contains("latencySeconds")) {
            std::wostringstream latency; latency << std::fixed << std::setprecision(1) << row["latencySeconds"].get<double>() * 1000;
            text += L" · " + latency.str() + L" ms";
        }
    }
    return text;
}

// A start reply may arrive after its view has closed. Register before posting
// the reply, so either retirement or the late worker owns its cancellation.
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
}
