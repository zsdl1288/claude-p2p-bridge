#pragma once
#include <string>
#include "vendor/json.hpp"

namespace DesktopPairingUi {
struct State {
    bool saved = false, valid = false, paused = false, editable = false;
    bool canForget = false, canToggle = false, resume = false;
    std::wstring detail;
};

inline State FromStatus(const nlohmann::json& status) {
    const auto object = [](const nlohmann::json& value, const char* key) {
        return value.is_object() && value.contains(key) && value[key].is_object()
            ? value[key] : nlohmann::json::object();
    };
    const auto text = [](const nlohmann::json& value, const char* key) {
        return value.is_object() && value.contains(key) && value[key].is_string()
            ? value[key].get<std::string>() : std::string();
    };
    const auto flag = [](const nlohmann::json& value, const char* key, bool fallback = false) {
        return value.is_object() && value.contains(key) && value[key].is_boolean()
            ? value[key].get<bool>() : fallback;
    };
    const auto pairing = object(status, "pairing"), summary = object(pairing, "summary");
    const auto phase = text(pairing, "state");
    State state;
    state.saved = flag(pairing, "saved");
    state.paused = state.saved && flag(pairing, "paused", phase == "paused");
    // Only durable invalidation opens the editor. A socket error, an offline
    // service or an explicitly disconnected private network retains pairing.
    const bool invalid = !flag(pairing, "valid", true) || phase == "invalid" || phase == "expired" || phase == "revoked" || phase == "error";
    state.valid = state.saved && !invalid;
    state.editable = !state.valid && !phase.empty() && phase != "loading";
    state.canForget = state.saved;
    state.canToggle = state.valid;
    state.resume = state.paused || (state.saved && phase == "network-disconnected");

    if (!state.valid) return state;
    const auto role = text(pairing, "role").empty() ? text(status, "role") : text(pairing, "role");
    state.detail = L"配对已保存\r\n本机身份：" + std::wstring(role == "host" ? L"服务端" : L"调用端");
    std::string endpoint = text(summary, "endpoint");
    if (endpoint.empty()) {
        auto host = text(summary, "host");
        if (host.empty()) host = text(summary, "address");
        if (!host.empty() && summary.contains("port") && summary["port"].is_number_integer())
            endpoint = host + ":" + std::to_string(summary["port"].get<int>());
    }
    if (endpoint.empty()) endpoint = text(status, "endpoint");
    // Pairing codes, secrets and arbitrary backend messages are never copied
    // into the read-only summary. Endpoints contain IP/hostname characters.
    if (!endpoint.empty() && endpoint.size() <= 260 && endpoint.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.:-[]_") == std::string::npos)
        state.detail += L"\r\n服务端地址：" + std::wstring(endpoint.begin(), endpoint.end());
    const wchar_t* connection = state.paused ? L"已暂停，可随时恢复"
        : phase == "network-disconnected" ? L"私有网络已断开，配对保留"
        : flag(status, "online") ? L"已连接"
        : phase == "waiting-network" ? L"等待私有网络恢复"
        : role == "host" ? L"等待调用端连接" : L"等待服务端上线，自动重连中";
    state.detail += L"\r\n连接状态：" + std::wstring(connection);
    return state;
}
}
