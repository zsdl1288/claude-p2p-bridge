#include "../native/desktop/platform.hpp"
#include "../native/desktop/model-api.hpp"
#include "../native/desktop/options.hpp"
#include "../native/desktop/role-ui.hpp"
#include <iostream>

namespace {
void Require(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }
void CheckNativeState() {
    Require(ApiErrorMessage({{"error", {{"message", "B 模型服务未启用"}, {"code", "unavailable"}}}}) == "B 模型服务未启用" &&
            ApiErrorMessage({{"error", "配对失败"}}) == "配对失败" && ApiErrorMessage({{"error", 42}}) == "本机 API 调用失败",
            "Native API errors must preserve both model-object and management-string diagnostics");
    Require(SafeLoginUrl("https://login.tailscale.com/a/test") && SafeLoginUrl("https://login.tailscale.com:443/a/test"),
            "Official HTTPS login URLs should be accepted");
    for (const auto& url : {"http://login.tailscale.com/a/test", "https://login.tailscale.com:444/a/test", "https://login.tailscale.com.example.com/", "https://user@login.tailscale.com/"})
        Require(!SafeLoginUrl(url), "Untrusted login URL was accepted");
    for (const auto& arguments : std::vector<std::vector<std::wstring>>{
        {L"--data-dir", L""}, {L"--data-dir", L" \t"}, {L"--data-dir"},
        {L"--port", L" 3210"}, {L"--port", L"+3210"}, {L"--port", L"3210x"},
        {L"--port", L"0"}, {L"--port", L"65536"}, {L"--port", std::wstring(300, L'9')},
        {L"--port"}, {L"--unknown"}, {L"--version", L"--unknown"}
    }) {
        bool rejected = false;
        try { DesktopCli::Parse(arguments, L"Q:\\default"); } catch (...) { rejected = true; }
        Require(rejected, "Invalid native desktop startup parameters were accepted");
    }
    auto options = DesktopCli::Parse({L"--port", L"6543", L"--data-dir", L"Q:\\profile\\..\\current",
        L"--minimized", L"--demo", L"--system-tailscale", L"--version"}, L"Q:\\default");
    Require(options.port == 6543 && options.directory == L"Q:\\current" && options.minimized && options.demo && options.system && options.version,
            "Native desktop startup parsing changed valid options");
    Require(DesktopCli::Port(L"0", true) == 0 && DesktopCli::Port(L"65535") == 65535,
            "Demo ephemeral ports and maximum valid bridge ports must remain supported");

    Require(!DesktopAccess::FromStatus(Json()).CanSwitchRole() && !DesktopAccess::FromStatus(Json()).CanOpenPage(1),
            "An unloaded desktop status must not authorize role changes or model access");
    Json state = {{"identity", {{"role", "client"}, {"loaded", true}, {"locked", true}, {"desiredOnline", true}, {"canSwitchRole", false}}},
        {"capabilities", {{"model", true}, {"proxy", true}}}, {"network", {{"running", false}}}};
    auto offline = DesktopAccess::FromStatus(state);
    Require(offline.role == "client" && !offline.CanSwitchRole() && !offline.networkReady && offline.CanOpenPage(1) && offline.CanOpenPage(3),
            "Transient network loss must retain the identity lock and already paired business pages");
    state["controlConnectionId"] = "original-session";
    const auto scope = DesktopAccess::ModelTestScope(state);
    state["model"] = {{"available", false}};
    Require(!scope.empty() && DesktopAccess::ModelTestScope(state) == scope, "Disabling only the model service must preserve the test's device identity");
    state["controlConnectionId"] = "new-session";
    Require(DesktopAccess::ModelTestScope(state) != scope, "Re-pairing must retire replies from a previous native model test");
    state["capabilities"]["model"] = false;
    Require(DesktopAccess::ModelTestScope(state).empty(), "Revoked model authorization must retire native test replies even if the role stays A");
    state["capabilities"]["model"] = true;
    state["identity"]["locked"] = false; state["identity"]["canSwitchRole"] = true;
    Require(!DesktopAccess::FromStatus(state).CanSwitchRole(), "A desired-online network must remain locked while disconnect is pending");
    state["identity"]["desiredOnline"] = false;
    Require(DesktopAccess::FromStatus(state).CanSwitchRole(), "A completed explicit disconnect should unlock identity selection");
    state["identity"]["loaded"] = false;
    Require(!DesktopAccess::FromStatus(state).CanSwitchRole() && !DesktopAccess::FromStatus(state).CanOpenPage(3),
            "Startup capability hints must not bypass identity loading");
    state["identity"]["loaded"] = true; state["identity"]["role"] = "unknown";
    Require(DesktopAccess::FromStatus(state).role.empty() && !DesktopAccess::FromStatus(state).CanOpenPage(1), "Unknown roles must not inherit caller or server UI access");
    Require(DesktopAccess::PairingRecoveryHint({{"state", "network-disconnected"}}, false).find("当前不会自动联网") != std::string::npos,
            "Explicit private-network disconnect must not promise automatic reconnection");
    Require(DesktopAccess::PairingRecoveryHint({{"state", "paused"}}, true).find("已暂停") != std::string::npos &&
            DesktopAccess::PairingRecoveryHint({{"state", "error"}}, true).find("重新设置") != std::string::npos &&
            DesktopAccess::PairingRecoveryHint({{"state", "reconnecting"}}, true).find("自动恢复") != std::string::npos,
            "Paused, failed and transiently disconnected pairings need distinct recovery guidance");

    SseDecoder decoder;
    auto first = decoder.Feed(": heartbeat\r\n\r\nevent: progress\r\ndata:{\"type\":\r\n");
    Require(first.empty(), "Incomplete SSE event should wait for more bytes");
    auto events = decoder.Feed("data: \"queued\", \"position\": 1}\r\n\r\ndata: {\"type\":\"done\"}\n\n");
    Require(events.size() == 2 && events[0].at("type") == "queued" && events[1].at("type") == "done", "CRLF, comments and multiline SSE framing failed");
    auto completed = decoder.Feed("data: {\"choices\":[{\"delta\":{\"content\":\"Claude\"}}]}\n\ndata: [DO");
    Require(completed.size() == 1 && completed[0]["choices"][0]["delta"]["content"] == "Claude", "Model SSE chunk was not preserved");
    auto sentinel = decoder.Feed("NE]\n\n");
    Require(sentinel.size() == 1 && sentinel[0].value("type", "") == "sse-done", "Fragmented OpenAI completion sentinel was not accepted");
    bool rejected = false;
    try { SseDecoder().Feed(std::string(4 * 1024 * 1024 + 1, 'x')); } catch (...) { rejected = true; }
    Require(rejected, "Unbounded partial SSE frame was accepted");
    rejected = false;
    try { SseDecoder().Feed("data: [INVALID]\n\n"); } catch (...) { rejected = true; }
    Require(rejected, "An arbitrary non-JSON SSE payload was accepted as a completion");
    rejected = false;
    try { SseDecoder().Feed(std::string("data: {\"text\":\"") + '\xFF' + "\"}\n\n"); } catch (...) { rejected = true; }
    Require(rejected, "Invalid UTF-8 SSE JSON was accepted");

    Require(DesktopModelApi::BaseUrl(6543) == L"http://127.0.0.1:6543/v1", "Harness must receive the model provider base URL");
    auto modelExample = DesktopModelApi::PowerShellExample(L"Q:\\one's profile", 6543, L"claude-new-model-2099");
    Require(modelExample.find(L"-LiteralPath 'Q:\\one''s profile\\api-token'") != std::wstring::npos,
            "The model API example must quote token paths safely");
    Require(modelExample.find(L"http://127.0.0.1:6543/v1/chat/completions") != std::wstring::npos &&
            modelExample.find(L"messages = @(@{") != std::wstring::npos && modelExample.find(L"model = 'claude-new-model-2099'") != std::wstring::npos &&
            modelExample.find(L"/v1/run") == std::wstring::npos,
            "The copied example must call the model API instead of the B task endpoint");
    Require(DesktopModelApi::PowerShellExample(L"Q:\\profile", 6543, L"provider's-model").find(L"model = 'provider''s-model'") != std::wstring::npos,
            "The selected model ID must be preserved and quoted safely in copied PowerShell");
}
}

int main(int argc, char** argv) {
    try {
        if (argc != 2) throw std::runtime_error("Expected the fixture port");
        CheckNativeState();
        if (std::string_view(argv[1]) == "--state-only") return 0;
        Require(LocalHttpListening(std::stoi(argv[1])), "A non-JSON HTTP response must still identify an occupied port");
        bool modelError = false;
        try { LocalRequest failure(std::stoi(argv[1]), "", L"/model-error"); failure.ReadJson(); }
        catch (const std::exception& error) { modelError = std::string(error.what()) == "B 模型服务未启用"; }
        Require(modelError, "WinHTTP must display a model API's error message rather than a JSON type-conversion exception");
        LocalRequest request(std::stoi(argv[1]), "", L"/events", nullptr, 3000);
        if (request.status != 200) throw std::runtime_error("SSE fixture rejected the request");
        SseDecoder decoder;
        char chunk[8192];
        std::vector<std::string> events;
        for (;;) {
            DWORD received = request.ReadAvailable(chunk, sizeof(chunk));
            if (!received) break;
            for (const auto& event : decoder.Feed(std::string_view(chunk, received))) {
                auto type = event.at("type").get<std::string>();
                if (type == "queued" && (event.at("position") != 1 || event.at("message") != "正在排队"))
                    throw std::runtime_error("Fragmented UTF-8 queue event was corrupted");
                events.push_back(type);
                std::cout << type << std::endl;
            }
        }
        if (events != std::vector<std::string>{"queued", "started", "done"})
            throw std::runtime_error("Unexpected SSE event order");
        // Desktop shutdown closes the engine's HTTP connections before joining
        // an action that can otherwise wait several minutes for UAC.
        auto started = std::chrono::steady_clock::now();
        bool closed = false;
        try { LocalRequest slow(std::stoi(argv[1]), "", L"/slow-action", nullptr, 330000); slow.ReadJson(); }
        catch (...) { closed = true; }
        Require(closed && std::chrono::steady_clock::now() - started < std::chrono::seconds(3),
                "Closing the engine connection did not interrupt a long native action promptly");
        std::cout << "closed" << std::endl;
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << std::endl;
        return 1;
    }
}
