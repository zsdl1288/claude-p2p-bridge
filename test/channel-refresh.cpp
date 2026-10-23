#include "../native/desktop/channel-refresh.hpp"
#include <iostream>
#include <limits>

void Require(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }

int main() {
    try {
        using namespace DesktopChannelRefresh;
        Json state = {{"connected", true}, {"available", true}, {"busy", false}, {"retryAfterMs", 0}, {"reason", "ready"}, {"job", nullptr},
            {"targets", Json::array({{{"id", "opaque-B"}, {"name", "paired B"}, {"role", "host"}, {"address", "100.64.1.2"}, {"supported", true}}})}};
        Require(CanStart(state, "client") && CanStartTarget(state, "client", "opaque-B"), "A must refresh only its single current B");
        Require(!CanStartTarget(state, "client", "100.64.1.2") && !CanStartTarget(state, "client", "paired B") && !CanStart(state, "host"), "Display addresses, names or wrong roles cannot select a target");
        state["connected"] = false; Require(!CanStart(state, "client"), "Offline state must not reuse stale targets"); state["connected"] = true;
        state["targets"].push_back({{"id", "other-B"}, {"role", "host"}, {"supported", true}});
        Require(!CanStart(state, "client"), "Ambiguous client B selection must fail closed");
        state["targets"] = Json::array({{{"id", "current-A"}, {"name", "A&B"}, {"role", "client"}, {"supported", true}}, {{"id", "old-A"}, {"role", "client"}, {"supported", false}}, {{"id", "intruder"}, {"role", "host"}, {"supported", true}}});
        Require(CanStart(state, "host") && Targets(state, "host").size() == 2 && CanStartTarget(state, "host", "current-A") && !CanStartTarget(state, "host", "old-A"), "B requires an explicitly selected supported A from the authorized API list");
        Require(MenuLabel(Targets(state, "host")[0]) == L"A&&B" && MenuLabel(Targets(state, "host")[1]).find(L"1.2.1") != std::wstring::npos, "Popup text must escape menu accelerators and identify old peers");
        auto malformed = state;
        malformed["targets"][0]["supported"] = "true"; malformed["targets"][0]["name"] = "A\nprivate-note"; malformed["targets"][0]["address"] = "private-note";
        Require(!CanStartTarget(malformed, "host", "current-A") && Targets(malformed, "host")[0]["name"] == "" && Targets(malformed, "host")[0]["address"] == "", "Malformed support flags and control-bearing labels must fail closed");
        for (const auto& blocked : {Json("0"), Json(-1), Json(nullptr)}) { state["retryAfterMs"] = blocked; Require(!CanStart(state, "host"), "Malformed cooldown cannot enable a refresh"); }
        state["retryAfterMs"] = 120000; state["reason"] = "cooldown";
        Require(!CanStart(state, "host") && Button(state).find(L"120秒") != std::wstring::npos && Message(state).find(L"120 秒") != std::wstring::npos, "Two-minute cooldown must be visible and enforced");
        state["retryAfterMs"] = 1800000; state["reason"] = "budget-exhausted";
        Require(!CanStart(state, "host") && Cooldown(state) == 1800000 && Button(state).find(L"1800秒") != std::wstring::npos, "The shared recovery budget can require a full thirty-minute cooldown");
        state["retryAfterMs"] = 1; Require(Button(state).find(L"1秒") != std::wstring::npos, "Cooldown should round up instead of falsely showing zero");
        state["retryAfterMs"] = 0; state["job"] = {{"id", "job1"}, {"state", "running"}, {"phase", "after"}};
        Require(!CanStart(state, "host") && Button(state) == L"刷新中…" && Message(state).find(L"观察线路") != std::wstring::npos, "A running backend job must disable start even if status flags are inconsistent");
        state["reason"] = "ready";
        state["job"] = {{"id", "job1"}, {"targetId", "current-A"}, {"state", "completed"}, {"result", {{"refreshed", true}, {"reason", "refreshed"}, {"before", {{"path", "derp"}, {"latencyMs", 432.5}}}, {"after", {{"path", "direct"}, {"latencyMs", 85.2}}}, {"changed", true}, {"secret", "private-do-not-show"}}}};
        const auto completed = Message(state);
        Require(completed.find(L"当前直连") != std::wstring::npos && completed.find(L"不保证提速") != std::wstring::npos && completed.find(L"432.5 ms → 85.2 ms") != std::wstring::npos && completed.find(L"private-do-not-show") == std::wstring::npos, "Completed results must show safe measured paths and RTT without asserting a node switch or guaranteed improvement");
        auto late = state; late["busy"] = true; late["job"]["state"] = "running"; late["job"]["phase"] = "before"; late["job"]["result"] = nullptr;
        Require(MergeCommand(state, late) == state && Button(MergeCommand(state, late)) != L"刷新中…", "A late HTTP 202 cannot regress a polled completed job to running");
        auto failed = state; failed["job"]["state"] = "failed";
        Require(MergeCommand(failed, late) == failed, "A late HTTP 202 cannot overwrite an observed failed result");
        auto newJob = late; newJob["job"]["id"] = "job2";
        Require(MergeCommand(state, newJob) == newJob, "A genuinely new accepted job must still be displayed");
        state["targets"][0]["id"] = "new-current-A";
        Require(Message(state).find(L"当前直连") == std::wstring::npos && Message(state).find(L"上次刷新测得") != std::wstring::npos, "A retained result from an old target cannot describe a different currently connected device");
        state["targets"][0]["id"] = "current-A";
        state["connected"] = false; state["reason"] = "not-connected";
        Require(Message(state).find(L"当前直连") == std::wstring::npos && Message(state).find(L"上次刷新测得") != std::wstring::npos && Message(state).find(L"已断开") != std::wstring::npos, "Disconnected state must not present an old successful path as current");
        state["connected"] = true; state["reason"] = "ready";
        state["job"]["state"] = "failed"; state["job"]["result"]["reason"] = "deadline";
        state["job"]["result"]["after"] = {{"path", "private-path"}, {"latencyMs", nullptr}};
        Require(Message(state).find(L"后续观察未完成") != std::wstring::npos && Message(state).find(L"已重新探测，当前") == std::wstring::npos && Message(state).find(L"→ —") != std::wstring::npos, "An accepted action with failed observation must not be presented as success");
        Require(Path({{"path", "private-path"}}) == L"线路待确认" && Rtt({{"latencyMs", -1}}) == L"—" && Rtt({{"latencyMs", std::numeric_limits<double>::infinity()}}) == L"—", "Missing or invalid observations cannot invent a path or RTT");
        Json status = {{"instanceId", "engine1"}, {"pairing", {{"saved", true}, {"valid", true}, {"paused", false}, {"summary", {{"endpoint", "100.64.1.2:1234"}}}}}};
        auto scope = Scope(status, state, "host");
        status["pairing"]["summary"]["endpoint"] = "100.64.1.3:1234"; Require(scope != Scope(status, state, "host"), "A late response from an old pairing must be rejected");
        scope = Scope(status, state, "host"); state["targets"][0]["id"] = "replacement-connection"; Require(scope != Scope(status, state, "host"), "A late response must not select a reconnected session using a stale ID");
        Require(scope != Scope(status, state, "client"), "Role changes must invalidate pending refresh replies");
        std::cout << "Native channel refresh qualification, safe results and reply scope tests passed\n";
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
