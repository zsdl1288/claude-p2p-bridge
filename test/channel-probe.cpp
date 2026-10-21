#include "../native/desktop/channel-probe.hpp"
#include <iostream>

void Require(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }

int main() {
    try {
        using namespace DesktopChannelProbe;
        Json report = {{"v", 1}, {"completed", true}, {"startedAtUtc", "2026-10-21T18:10:00.000Z"},
            {"finishedAtUtc", "2026-10-21T18:10:10.000Z"}, {"targetRole", "host"}, {"plannedProbes", 9},
            {"completedProbes", 3}, {"replies", 1}, {"maximumSeconds", 35}, {"helperUnchanged", true}, {"stopReason", nullptr},
            {"results", Json::array({
                {{"type", "TSMP"}, {"size", 0}, {"outcome", "reply"}, {"latencySeconds", 0.1234}, {"actualVia", "unknown"}},
                {{"type", "disco"}, {"size", 128}, {"outcome", "timeout"}, {"actualVia", "unknown"}},
                {{"type", "disco"}, {"size", 1200}, {"outcome", "busy"}, {"actualVia", "unexpected-path"}}
            })}, {"notes", Json::array({"探测回复数量不等于公网丢包率。"})}};
        Json state = {{"available", true}, {"reason", "ready"}, {"busy", false}, {"retryAfterMs", 0},
            {"targets", Json::array({{{"id", "paired-session"}, {"name", "my-B"}, {"address", "100.64.1.2"}, {"role", "host"}}})},
            {"job", {{"id", "owned-job"}, {"state", "completed"}, {"report", report}}}};
        Require(CanStart(state) && Targets(state).size() == 1, "Ready target selection must use an existing authenticated target");
        state["busy"] = true; Require(!CanStart(state), "Busy jobs cannot start another probe");
        state["busy"] = false; state["retryAfterMs"] = 1500; Require(!CanStart(state), "Start cooldown must be respected");
        state["retryAfterMs"] = 0; state["job"]["state"] = "running"; Require(Running(state) && !CanStart(state), "Running jobs must disable start");
        Require(!CanStart({{"available", "invalid"}, {"busy", 0}}) && Targets(Json()).empty(), "Malformed state must be safe and unavailable");
        state["job"]["state"] = "completed";
        auto safe = Report(report);
        auto text = Format(state, safe);
        Require(safe.is_object() && safe["results"][2]["actualVia"] == "unknown", "Unknown paths must remain unknown");
        Require(text.find(L"TSMP 小包：回复 · 路径未知 · 123.4 ms") != std::wstring::npos, "Reply RTT/path formatting was incorrect");
        Require(text.find(L"disco 128：超时") != std::wstring::npos && text.find(L"disco 1200：组件忙") != std::wstring::npos, "Timeout and busy are distinct outcomes");
        Require(text.find(L"不是带宽测速") != std::wstring::npos && text.find(L"回复数量不能当作真实公网丢包率") != std::wstring::npos, "Probe limits must be explicit");
        report["token"] = "secret-token"; report["jobId"] = "private-job"; report["targetName"] = "private-name";
        report["address"] = "100.95.24.20"; report["status"] = {{"subscriptionUrl", "private-subscription"}};
        report["notes"] = Json::array({"private-token-from-notes", "my-secret-name 100.95.24.20"});
        report["results"][0]["endpoint"] = "223.1.2.3:4567"; report["results"][0]["session"] = "private-session";
        report["results"][0]["actualVia"] = "direct";
        Require(Report(report)["results"][0]["actualVia"] == "unknown", "TSMP must never project a native path claim");
        const auto exported = Report(report).dump();
        for (const auto* privateValue : {"secret-token", "private-job", "private-name", "100.95.24.20", "private-subscription", "223.1.2.3", "private-session", "private-token-from-notes", "my-secret-name"})
            Require(exported.find(privateValue) == std::string::npos, "Export leaked a field outside the report whitelist");
        report["results"][0] = {{"type", "disco"}, {"size", 128}, {"outcome", "reply"}, {"latencySeconds", 0.2},
            {"actualVia", "derp"}, {"derpRegionId", 21}, {"derpRegionCode", "yvr"}};
        safe = Report(report);
        Require(safe["results"][0]["derpRegionId"] == 21 && Format(state, safe).find(L"DERP 中继") != std::wstring::npos, "Safe DERP metadata must survive");
        report["completedProbes"] = 10; Require(Report(report).is_null(), "Oversized reports must not be exported");
        Require(Report(Json()).is_null() && Format(Json(), Json()).find(L"发送少量探测包") != std::wstring::npos, "Idle/missing reports must remain usable");

        OwnedJobs ownership;
        const auto first = ownership.BeginView();
        Require(!ownership.Register("my-job", first), "An active view unexpectedly retired its own job");
        Require(!ownership.ClaimCancel("external-job"), "Closing a view must never cancel another API caller's job");
        const auto retired = ownership.Retire();
        Require(retired.size() == 1 && retired[0] == "my-job" && !ownership.Current(first), "Retirement lost the UI-created job");
        Require(ownership.ClaimCancel("my-job") && !ownership.ClaimCancel("my-job"), "Concurrent close/cancel paths must not duplicate cancellation");
        ownership.FinishCancel("my-job", true);
        Require(!ownership.ClaimCancel("my-job"), "Finished cancellation retained ownership");
        const auto second = ownership.BeginView(); ownership.Retire();
        Require(ownership.Register("late-start", second) && ownership.ClaimCancel("late-start"), "A start reply arriving after close must be cancelled by its worker");
        ownership.FinishCancel("late-start", false);
        Require(ownership.ClaimCancel("late-start"), "A failed bounded cancel must remain available for a later retirement retry");
        ownership.FinishCancel("late-start", true);
        const auto third = ownership.BeginView(); ownership.Register("completed", third); ownership.Forget("completed");
        Require(ownership.Retire().empty(), "A completed report must not keep a cancellable job");
        const auto fourth = ownership.BeginView(); ownership.Register("old", fourth); ownership.Register("new", fourth);
        Require(!ownership.ClaimCancel("old") && ownership.ClaimCancel("new"), "Only the backend's most recently created job can retain ownership");
        ownership.ObserveOnly("other-api-job");
        Require(ownership.Retire().empty() && !ownership.ClaimCancel("other-api-job"), "An authoritative newer job must prune old IDs without owning another caller's job");
        std::cout << "Channel probe formatter, export whitelist and owned-job lifecycle passed\n";
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
