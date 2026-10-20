#pragma once
#include <string>
#include "role-ui.hpp"

namespace DesktopConnectionStatus {
enum class Tone { Error, Waiting, Connected };
struct Badge { std::wstring text; Tone tone; };

inline Badge FromStatus(const nlohmann::json& status, bool demo = false) {
    const auto object = [&](const char* key) {
        return status.is_object() && status.contains(key) && status[key].is_object()
            ? status[key] : nlohmann::json::object();
    };
    const auto identity = object("identity"), network = object("network");
    const auto access = DesktopAccess::FromStatus(status, demo);
    const auto error = identity.value("error", nlohmann::json());
    if (identity.value("state", "") == "error" || (error.is_string() && !error.get_ref<const std::string&>().empty()))
        return {L"连接异常 · 请检查运行记录", Tone::Error};
    if (!access.loaded) return {L"正在读取本机身份…", Tone::Waiting};
    if (access.role.empty()) return {L"请选择本机身份", Tone::Error};
    if (!access.locked) return {L"身份未锁定 · 请连接私有网络", Tone::Error};

    const auto backend = network.value("backendState", "");
    const bool needsLogin = !network.value("running", false) &&
        (backend == "NeedsLogin" || backend == "NeedsMachineAuth" || !network.value("authUrl", "").empty());
    if (needsLogin) return {backend == "NeedsMachineAuth" ? L"设备等待授权 · 尚未登录" : L"尚未登录 · 请完成浏览器登录", Tone::Error};

    const auto pairing = object("pairing");
    const auto phase = pairing.value("state", "");
    if (phase == "invalid" || phase == "error" || (pairing.value("saved", false) && !pairing.value("valid", true)))
        return {L"配对已失效 · 请重新配对", Tone::Error};
    if (pairing.value("paused", phase == "paused")) return {L"配对已暂停 · 可恢复连接", Tone::Waiting};

    if (status.value("online", false)) {
        if (access.role == "host") return {L"服务端 · " + std::to_wstring(status.value("connectedClients", 0)) + L" 个调用端已连接", Tone::Connected};
        return {L"调用端 · 已配对连接", Tone::Connected};
    }
    return {L"身份已锁定 · 等待连接", Tone::Waiting};
}
}
