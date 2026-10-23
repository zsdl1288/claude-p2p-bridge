#pragma once
#include "platform.hpp"
#include <cmath>
#include <set>

namespace DesktopChannelRefresh {
inline std::string Text(const Json& value, const char* key, size_t maximum = 128) {
    if (!value.is_object() || !value.contains(key) || !value[key].is_string()) return {};
    const auto text = value[key].get<std::string>();
    if (text.size() > maximum || std::any_of(text.begin(), text.end(), [](unsigned char c) { return c < 32 || c == 127; })) return {};
    return text;
}
inline bool Flag(const Json& value, const char* key, bool expected = true) {
    return value.is_object() && value.contains(key) && value[key].is_boolean() && value[key].get<bool>() == expected;
}
inline uint64_t Cooldown(const Json& value) {
    constexpr uint64_t maximum = 1800000;
    if (!value.is_object() || !value.contains("retryAfterMs")) return maximum;
    const auto& number = value["retryAfterMs"];
    if (number.is_number_unsigned()) return std::min(number.get<uint64_t>(), maximum);
    if (number.is_number_integer() && number.get<int64_t>() >= 0) return std::min(static_cast<uint64_t>(number.get<int64_t>()), maximum);
    return maximum;
}
inline Json Job(const Json& state) {
    if (!state.is_object() || !state.contains("job") || !state["job"].is_object()) return Json::object();
    const auto& job = state["job"];
    const auto phase = Text(job, "state");
    return !Text(job, "id").empty() && (phase == "running" || phase == "completed" || phase == "failed") ? job : Json::object();
}
inline bool Running(const Json& state) { return Text(Job(state), "state") == "running"; }
inline Json MergeCommand(const Json& current, const Json& incoming) {
    if (!incoming.is_object()) return current;
    const auto observed = Job(current), reply = Job(incoming);
    // Full polls are authoritative. A delayed HTTP 202 cannot put the same
    // job back into its starting state after a poll observed its final result.
    if (!Text(observed, "id").empty() && Text(observed, "id") == Text(reply, "id") &&
        (Text(observed, "state") == "completed" || Text(observed, "state") == "failed")) return current;
    return incoming;
}
inline std::vector<Json> Targets(const Json& state, const std::string& role) {
    std::vector<Json> result;
    if ((role != "client" && role != "host") || !state.is_object() || !state.contains("targets") || !state["targets"].is_array()) return result;
    const auto expected = role == "client" ? "host" : "client";
    std::set<std::string> seen;
    for (const auto& row : state["targets"]) {
        const auto id = Text(row, "id");
        if (result.size() >= 16 || id.empty() || Text(row, "role") != expected || !seen.insert(id).second) continue;
        const auto address = Text(row, "address", 80);
        const bool addressSafe = !address.empty() && address.find_first_not_of("0123456789.:abcdefABCDEF") == std::string::npos;
        result.push_back({{"id", id}, {"name", Text(row, "name", 256)}, {"role", expected}, {"supported", Flag(row, "supported")}, {"address", addressSafe ? address : ""}});
    }
    return result;
}
inline bool CanStart(const Json& state, const std::string& role) {
    if (!Flag(state, "connected") || !Flag(state, "available") || !Flag(state, "busy", false) || Cooldown(state) != 0 || Running(state)) return false;
    const auto targets = Targets(state, role);
    if (role == "client" && targets.size() != 1) return false;
    return std::any_of(targets.begin(), targets.end(), [](const auto& row) { return row["supported"] == true; });
}
inline bool CanStartTarget(const Json& state, const std::string& role, const std::string& id) {
    if (id.empty() || !CanStart(state, role)) return false;
    const auto targets = Targets(state, role);
    return std::any_of(targets.begin(), targets.end(), [&](const auto& row) { return Text(row, "id") == id && Flag(row, "supported"); });
}
inline bool CurrentJobTarget(const Json& state, const Json& job) {
    const auto id = Text(job, "targetId");
    if (!Flag(state, "connected") || id.empty()) return false;
    for (const auto* role : {"host", "client"}) for (const auto& target : Targets(state, role))
        if (Text(target, "id") == id) return true;
    return false;
}
inline std::wstring Button(const Json& state, bool submitting = false) {
    if (submitting || Flag(state, "busy") || Running(state)) return L"刷新中…";
    const auto remaining = Cooldown(state);
    const bool valid = state.is_object() && state.contains("retryAfterMs") && state["retryAfterMs"].is_number_integer() && state["retryAfterMs"] >= 0;
    return valid && remaining ? L"刷新线路 " + std::to_wstring((remaining + 999) / 1000) + L"秒" : L"刷新线路";
}
inline std::wstring Reason(const std::string& reason) {
    if (reason == "unsupported") return L"所选调用端需升级至 1.2.1，才能远程刷新线路。";
    if (reason == "model-busy") return L"模型任务正在执行或排队，请稍后刷新线路。";
    if (reason == "speed-busy") return L"正在测速，请结束测速后再刷新线路。";
    if (reason == "recovery-busy" || reason == "busy") return L"Bridge 正在恢复或刷新通道，请稍后。";
    if (reason == "cooldown") return L"线路刷新冷却中，请稍后重试。";
    if (reason == "budget-exhausted") return L"通道恢复次数已达短时上限，请稍后重试。";
    if (reason == "target-changed" || reason == "not-connected" || reason == "control-unavailable") return L"配对设备已断开或连接发生变化，等待连接恢复。";
    if (reason == "helper-changed" || reason == "network-stopped" || reason == "unavailable" || reason == "closed") return L"Bridge 组网组件暂未就绪，请等待连接恢复。";
    if (reason == "deadline") return L"已达到 20 秒时限。";
    if (reason == "user-cancelled") return L"本次线路刷新已停止。";
    return L"连接服务端后可刷新 Bridge 自己的线路，现有配对保留。";
}
inline std::wstring Path(const Json& path) {
    const auto kind = Text(path, "path");
    if (kind == "direct") return L"直连";
    if (kind == "derp") return L"DERP 中继";
    if (kind == "peer-relay") return L"对等中继";
    return L"线路待确认";
}
inline std::wstring Rtt(const Json& value) {
    if (!value.is_object() || !value.contains("latencyMs") || !value["latencyMs"].is_number()) return L"—";
    const auto number = value["latencyMs"].get<double>();
    if (!std::isfinite(number) || number < 0 || number > 120000) return L"—";
    std::wostringstream output; output << std::fixed << std::setprecision(1) << number;
    return output.str() + L" ms";
}
inline std::wstring Message(const Json& state) {
    const auto job = Job(state);
    const auto phase = Text(job, "phase");
    if (Running(state)) return phase == "before" ? L"正在读取当前线路…（最多 20 秒）" : phase == "after" ? L"已请求重新探测，正在观察线路…（最多 20 秒）" : L"正在重新探测 Bridge 通道…（最多 20 秒）";
    if (job.is_object() && job.contains("result") && job["result"].is_object()) {
        const auto& result = job["result"];
        const auto before = result.contains("before") && result["before"].is_object() ? result["before"] : Json::object();
        const auto after = result.contains("after") && result["after"].is_object() ? result["after"] : Json::object();
        const bool success = Text(job, "state") == "completed" && Flag(result, "refreshed") && Text(result, "reason") == "refreshed";
        auto message = success ? (CurrentJobTarget(state, job) ? std::wstring(L"已重新探测，当前") : std::wstring(L"上次刷新测得")) + Path(after) + L"；可能仍是原线路，不保证提速。" :
            (Flag(result, "refreshed") ? std::wstring(L"已请求重新探测，后续观察未完成。") : std::wstring{}) + Reason(Text(result, "reason"));
        message += L" RTT " + Rtt(before) + L" → " + Rtt(after);
        const auto reason = Text(state, "reason");
        if (success && reason != "ready" && reason != "cooldown" && reason != "refreshed") message += L"\r\n" + Reason(reason);
        return message;
    }
    const auto remaining = Cooldown(state);
    if (Text(state, "reason") == "cooldown" && remaining) return L"线路刷新冷却中，还需约 " + std::to_wstring((remaining + 999) / 1000) + L" 秒。";
    return Reason(Text(state, "reason"));
}
inline std::wstring MenuLabel(const Json& target) {
    auto name = Text(target, "name", 256);
    if (name.empty()) name = "已授权调用端";
    const auto address = Text(target, "address", 80);
    auto text = Wide(name) + (address.empty() ? L"" : L" · " + Wide(address));
    for (size_t at = 0; (at = text.find(L'&', at)) != std::wstring::npos; at += 2) text.insert(at, 1, L'&');
    return text + (Flag(target, "supported") ? L"" : L"（需升级 1.2.1）");
}
// Reply scopes include only the current engine, role, pairing identity and
// opaque connection IDs. Displayed names or addresses never select a peer.
inline std::string Scope(const Json& status, const Json& state, const std::string& role) {
    Json scope = {{"instance", Text(status, "instanceId")}, {"role", role}, {"targets", Json::array()}};
    if (status.is_object() && status.contains("pairing") && status["pairing"].is_object()) {
        const auto& pair = status["pairing"];
        scope["saved"] = Flag(pair, "saved"); scope["valid"] = Flag(pair, "valid"); scope["paused"] = Flag(pair, "paused");
        if (pair.contains("summary") && pair["summary"].is_object()) scope["endpoint"] = Text(pair["summary"], "endpoint", 260);
    }
    for (const auto& target : Targets(state, role)) scope["targets"].push_back(Text(target, "id"));
    return scope.dump();
}
}
