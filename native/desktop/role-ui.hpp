#pragma once
#include <string>
#include "vendor/json.hpp"

namespace DesktopAccess {
struct State {
    std::string role;
    bool loaded = false, locked = true, networkReady = false, model = false, proxy = false;
    bool CanSwitchRole() const { return loaded && !locked; }
    bool CanOpenPage(int page) const { return page == 1 ? model : page == 3 ? proxy : true; }
};

inline State FromStatus(const nlohmann::json& status, bool demo = false) {
    const auto object = [&](const char* key) {
        return status.is_object() && status.contains(key) && status[key].is_object() ? status[key] : nlohmann::json::object();
    };
    const auto identity = object("identity"), capabilities = object("capabilities"), network = object("network");
    State state;
    auto role = identity.value("role", nlohmann::json());
    if (role == "client" || role == "host") state.role = role.get<std::string>();
    state.loaded = identity.value("loaded", false);
    // A missing snapshot, a pending network connection and transient network
    // loss must never be mistaken for permission to change identity.
    state.locked = !state.loaded || identity.value("locked", false) || identity.value("desiredOnline", false) || !identity.value("canSwitchRole", false);
    state.networkReady = network.value("running", false) || (demo && identity.value("desiredOnline", false));
    state.model = state.loaded && !state.role.empty() && capabilities.value("model", false);
    state.proxy = state.loaded && !state.role.empty() && capabilities.value("proxy", false);
    return state;
}

inline std::string PairingRecoveryHint(const nlohmann::json& pairing, bool desiredOnline) {
    const auto phase = pairing.value("state", "");
    if (!desiredOnline || phase == "network-disconnected") return "已保存；重新连接私有网络后恢复，当前不会自动联网。";
    if (phase == "error") return "可忘记配对后重新设置。";
    if (phase == "paused") return "配对已暂停；可恢复，身份仍锁定。";
    return "已保存 · 临时掉线后自动恢复";
}

inline std::string ModelTestScope(const nlohmann::json& status) {
    const auto access = FromStatus(status);
    if (access.role != "client" || !access.model || !status.contains("controlConnectionId") || !status["controlConnectionId"].is_string()) return {};
    return status["controlConnectionId"].get<std::string>();
}
}
