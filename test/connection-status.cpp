#include "../native/desktop/connection-status.hpp"
#include <cassert>
#include <iostream>

int main() {
    using namespace DesktopConnectionStatus;
    using Json = nlohmann::json;
    assert(FromStatus(Json()).tone == Tone::Waiting);
    assert(FromStatus({{"identity", {{"loaded", false}, {"state", "error"}}}}).tone == Tone::Error);
    assert(FromStatus({{"identity", {{"loaded", false}, {"error", "storage unavailable"}}}}).tone == Tone::Error);

    Json state = {{"identity", {{"loaded", true}, {"role", nullptr}, {"locked", false}, {"desiredOnline", false}, {"canSwitchRole", true}}},
        {"network", {{"running", false}, {"backendState", "Stopped"}}}, {"online", false}};
    assert(FromStatus(state).tone == Tone::Error);
    state["identity"]["role"] = "client";
    assert(FromStatus(state).tone == Tone::Error);
    state["online"] = true;
    assert(FromStatus(state).tone == Tone::Error); // A stale online flag cannot unlock the identity prerequisite.
    state["online"] = false;
    state["identity"]["locked"] = true;
    state["identity"]["canSwitchRole"] = false;
    assert(FromStatus(state).tone == Tone::Waiting);
    assert(FromStatus(state).text == L"身份已锁定 · 等待连接");

    state["network"]["backendState"] = "NeedsLogin";
    assert(FromStatus(state).tone == Tone::Error);
    state["online"] = true;
    assert(FromStatus(state).tone == Tone::Error); // Login state wins over a stale peer connection.
    state["network"]["backendState"] = "NeedsMachineAuth";
    assert(FromStatus(state).tone == Tone::Error);
    state["network"]["backendState"] = "Starting";
    state["network"]["authUrl"] = "https://login.tailscale.com/a/fixture";
    assert(FromStatus(state).tone == Tone::Error);

    state["network"]["running"] = true;
    assert(FromStatus(state).tone == Tone::Connected); // An old auth URL does not invalidate a running network.
    assert(FromStatus(state).text == L"调用端 · 已配对连接");
    state["identity"]["role"] = "host";
    state["connectedClients"] = 3;
    assert(FromStatus(state).tone == Tone::Connected);
    assert(FromStatus(state).text == L"服务端 · 3 个调用端已连接");
    state["identity"]["state"] = "error";
    assert(FromStatus(state).tone == Tone::Error);

    state["identity"]["state"] = "connected";
    state["identity"]["locked"] = false;
    state["identity"]["desiredOnline"] = true;
    state["identity"]["canSwitchRole"] = true;
    state["network"] = {{"running", false}, {"backendState", "Demo"}};
    assert(FromStatus(state, true).tone == Tone::Connected);
    state["online"] = false;
    assert(FromStatus(state, true).tone == Tone::Waiting);
    state["identity"]["loaded"] = false;
    assert(FromStatus(state, true).tone == Tone::Waiting);
    state["identity"]["loaded"] = true;
    state["pairing"] = {{"saved", true}, {"valid", true}, {"paused", true}};
    state["online"] = true;
    assert(FromStatus(state, true).tone == Tone::Waiting);
    state["pairing"]["valid"] = false;
    assert(FromStatus(state, true).tone == Tone::Error);
    assert(DesktopAccess::DisplayRoleNames(L"调用 B 的 Claude · Base URL / API Key") == L"调用 服务端 的 Claude · Base URL / API Key");
    assert(DesktopAccess::DisplayRoleNames(L"A 调用端 → B 服务端") == L"调用端 → 服务端");
    std::cout << "Connection status badge tests passed\n";
}
