#include "../native/desktop/pairing-ui.hpp"
#include <cassert>
#include <iostream>

int main() {
    using DesktopPairingUi::FromStatus;
    using Json = nlohmann::json;
    assert(!FromStatus(Json()).editable);
    assert(!FromStatus({{"pairing", {{"state", "loading"}}}}).editable);
    auto state = FromStatus({{"pairing", {{"saved", false}, {"state", "none"}}}});
    assert(state.editable && !state.canForget && !state.canToggle && state.detail.empty());

    Json status = {{"role", "client"}, {"online", true}, {"endpoint", "100.95.24.20:3211"},
        {"pairing", {{"saved", true}, {"role", "client"}, {"state", "connected"}, {"ready", true}}}};
    state = FromStatus(status);
    assert(state.saved && state.valid && !state.editable && state.canForget && state.canToggle && !state.resume);
    assert(state.detail.find(L"调用端") != std::wstring::npos && state.detail.find(L"100.95.24.20:3211") != std::wstring::npos);
    assert(state.detail.find(L"连接状态：已连接") != std::wstring::npos);

    status["online"] = false;
    status["error"] = "ECONNREFUSED";
    status["pairing"]["ready"] = false;
    for (const auto* phase : {"connecting", "waiting-network", "network-disconnected", "waiting-peer"}) {
        status["pairing"]["state"] = phase;
        state = FromStatus(status);
        assert(state.valid && !state.editable && state.canForget && state.canToggle);
        assert(state.resume == (std::string(phase) == "network-disconnected"));
    }

    status["pairing"]["state"] = "paused";
    status.erase("endpoint");
    status["pairing"]["summary"] = {{"host", "100.95.24.20"}, {"port", 3211}};
    state = FromStatus(status);
    assert(state.paused && !state.editable && state.resume && state.canToggle);
    assert(state.detail.find(L"100.95.24.20:3211") != std::wstring::npos);
    assert(state.detail.find(L"已暂停") != std::wstring::npos);
    status["pairing"]["paused"] = true;
    status["pairing"]["state"] = "network-disconnected";
    assert(FromStatus(status).paused && FromStatus(status).resume && !FromStatus(status).editable);
    status["pairing"]["valid"] = false;
    assert(FromStatus(status).editable && !FromStatus(status).canToggle && FromStatus(status).detail.empty()); // A prior explicit invalidation survives a later pause.
    status["pairing"].erase("valid");
    status["pairing"].erase("paused");

    for (const auto* phase : {"invalid", "expired", "revoked", "error"}) {
        status["pairing"]["state"] = phase;
        state = FromStatus(status);
        assert(state.saved && !state.valid && state.editable && state.canForget && !state.canToggle && state.detail.empty());
    }
    status["pairing"]["state"] = "connecting";
    status["pairing"]["valid"] = false;
    assert(FromStatus(status).editable); // Explicit validity wins over stale transport state.
    status["pairing"]["valid"] = true;
    status["pairing"]["state"] = "connected";
    status["pairing"]["summary"]["secret"] = "DO-NOT-DISPLAY";
    status["pairing"]["summary"]["invitation"] = "DO-NOT-DISPLAY";
    status["pairing"]["message"] = "DO-NOT-DISPLAY";
    status["invitation"] = "DO-NOT-DISPLAY";
    status["pairing"]["summary"]["endpoint"] = "100.95.24.20:3211";
    state = FromStatus(status);
    assert(state.detail.find(L"DO-NOT-DISPLAY") == std::wstring::npos);
    status["pairing"]["role"] = "host";
    assert(FromStatus(status).detail.find(L"本机身份：服务端") != std::wstring::npos);
    status["pairing"] = {{"saved", false}, {"state", "none"}};
    assert(FromStatus(status).editable && FromStatus(status).detail.empty());
    std::cout << "Pairing UI state tests passed\n";
}
