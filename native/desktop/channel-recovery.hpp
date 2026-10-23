#pragma once
#include "platform.hpp"

namespace DesktopChannelRecovery {
inline std::string Text(const Json& object, const char* key) {
    if (!object.is_object() || !object.contains(key) || !object[key].is_string()) return {};
    const auto value = object[key].get<std::string>();
    return value.size() <= 32 ? value : std::string{};
}
inline bool Flag(const Json& object, const char* key) {
    return object.is_object() && object.contains(key) && object[key].is_boolean() && object[key].get<bool>();
}
inline bool Integer(const Json& object, const char* key, uint64_t maximum, bool positive = false) {
    if (!object.is_object() || !object.contains(key)) return false;
    const auto& number = object[key];
    if (number.is_number_unsigned()) return number.get<uint64_t>() <= maximum && (!positive || number.get<uint64_t>() != 0);
    return number.is_number_integer() && number.get<int64_t>() >= (positive ? 1 : 0) && static_cast<uint64_t>(number.get<int64_t>()) <= maximum;
}
inline bool Suggested(const Json& state) {
    if (!state.is_object() || !state.contains("notice") || !state["notice"].is_object()) return false;
    const auto& notice = state["notice"];
    return Integer(notice, "id", 9007199254740991ULL, true) && Text(notice, "phase") == "suggested" &&
        Integer(notice, "ageMs", 300000) && notice.contains("result") && notice["result"].is_null();
}
inline std::wstring Cooldown(const Json& state) {
    if (!Integer(state, "cooldownMs", 120000, true)) return {};
    const auto milliseconds = state["cooldownMs"].get<uint64_t>();
    return std::to_wstring((milliseconds + 999) / 1000) + L"秒";
}
inline std::wstring Summary(const Json& state, const std::string& role, bool manualBusy = false) {
    if (role != "client" && role != "host") return L"通道监测：等待连接身份";
    if (!Flag(state, "enabled")) return L"通道监测：当前组网方式不可用";
    if (role == "host") return L"后台监测共享通道，由对应调用端决定刷新";
    if (Text(state, "mode") != "notify") return L"通道监测：等待状态更新";
    const auto phase = Text(state, "state");
    if (manualBusy) return L"正在按请求刷新线路，现有配对保留";
    if (phase == "refreshing") return L"正在重新探测 Bridge 通道";
    const auto cooldown = Cooldown(state);
    if (Suggested(state)) {
        if (phase == "budget-exhausted") return L"通道持续受阻，刷新额度暂满，请稍后";
        if (phase == "cooldown") return cooldown.empty() ? L"通道持续受阻，刷新冷却中，请稍后" : L"通道持续受阻，冷却 " + cooldown + L"后可刷新";
        if (phase == "waiting") return L"通道持续受阻，等待连接或任务空闲后可刷新";
        if (phase == "monitoring") return L"通道持续受阻，建议点击“刷新线路”";
    }
    if (phase == "budget-exhausted") return L"刷新额度暂满（30分钟最多3次）";
    if (phase == "cooldown") return cooldown.empty() ? L"通道监测：刷新冷却中" : L"通道监测：刷新冷却 " + cooldown;
    if (phase == "waiting") return L"后台监测待命，等待连接或任务空闲";
    if (phase == "monitoring") return L"后台监测中，持续卡顿时会提示刷新";
    return L"通道监测：等待状态更新";
}
}
