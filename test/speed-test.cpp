#include "../native/desktop/speed-test.hpp"
#include <iostream>
#include <limits>

void Require(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }

int main() {
    try {
        using namespace DesktopSpeedTest;
        Require(Rate({true, 1000000}) == L"8.00 Mbps" && Rate({true, 1000000}, false) == L"1.00 MB/s", "Decimal bit/byte units must agree");
        Require(Rate({}) == L"—" && Milliseconds({true, 123.45}) == L"123.5 ms", "Unknown rates and RTT precision are incorrect");
        Json live = {{"online", true}, {"self", false}, {"uploadBytesPerSecond", 1230000}, {"downloadBytesPerSecond", 4560000}, {"latencyMs", 128.0}};
        Require(DeviceLive(live) == L"↑ 1.23 MB/s ↓ 4.56 MB/s · 128 ms", "Live proxy metrics must use the backend's canonical A directions and decimal units");
        live["self"] = true; Require(DeviceLive(live).find(L"· —") != std::wstring::npos, "Self rows must not show a misleading self RTT");
        live["online"] = false; Require(DeviceLive(live) == L"—", "Offline metrics must not retain a stale rate or RTT");
        live = {{"online", true}, {"uploadBytesPerSecond", 12345}, {"downloadBytesPerSecond", nullptr}, {"latencyMs", nullptr}};
        Require(DeviceLive(live) == L"↑ 12.3 KB/s ↓ — · —" && DeviceLive(Json()) == L"—", "Missing or expired metrics must remain unknown");
        Json report = {{"v", 1}, {"completed", true}, {"startedAtUtc", "2026-10-21T20:00:00.000Z"}, {"finishedAtUtc", "2026-10-21T20:00:42.000Z"},
            {"targetRole", "host"}, {"maximumSeconds", 60}, {"maxBytesPerDirection", MaxBytes}, {"stopReason", nullptr},
            {"latency", {{"samples", Json::array({120.0, 124.0, 122.0, 126.0, 121.0})}, {"minMs", 1}, {"medianMs", 999}, {"maxMs", 9999}, {"failedSamples", 0}}},
            {"download", {{"receivedBytes", 40000000}, {"durationMs", 20000.0}, {"bytesPerSecond", 2000000.0}, {"completion", "complete"}, {"limitReached", false}}},
            {"upload", {{"receivedBytes", 8000000}, {"durationMs", 20000.0}, {"bytesPerSecond", 400000.0}, {"completion", "partial"}, {"limitReached", false}}},
            {"notes", Json::array({"injected-private-note"})}, {"targetId", "private-target"}, {"token", "private-token"}, {"address", "100.95.24.20"}, {"jobId", "private-job"}};
        Json state = {{"available", true}, {"connected", true}, {"reason", "ready"}, {"busy", false}, {"retryAfterMs", 0},
            {"targets", Json::array({{{"id", "current-pair"}, {"name", "my-B"}, {"address", "100.64.1.2"}, {"role", "host"}, {"supported", true}}})},
            {"job", {{"id", "current-job"}, {"state", "completed"}, {"progress", {{"phase", "completed"}}}, {"report", report}}}};
        auto safe = Report(report);
        Require(safe.is_object() && safe["latency"]["minMs"] == 120 && safe["latency"]["medianMs"] == 122 && safe["latency"]["maxMs"] == 126, "RTT summary must be computed from the actual samples");
        Require(Rate(Speed(state, safe, "download")) == L"16.00 Mbps" && Rate(Speed(state, safe, "upload"), false) == L"0.40 MB/s", "Directional throughput must preserve real measured bytes/second");
        Require(Latency(state, safe).value == 122, "RTT median must not trust an injected summary");
        Require(Details(state, safe).find(L"上传阶段未完整完成") != std::wstring::npos, "Partial throughput needs a clear incomplete label");
        const auto exported = safe.dump();
        for (const auto* forbidden : {"injected-private-note", "private-target", "private-token", "100.95.24.20", "private-job"}) Require(exported.find(forbidden) == std::string::npos, "Export leaked nonreport fields or notes");
        Require(CanStart(state) && Targets(state).size() == 1 && Targets(state)[0]["supported"] == true, "Connected supported pairing should be available");
        Require(!CanStartTarget(state, "") && !CanStartTarget(state, "100.64.1.2") && CanStartTarget(state, "current-pair"), "Start must require an explicitly selected current target, never an arbitrary address");
        state["targets"][0]["supported"] = false; Require(!CanStart(state), "An old peer must request upgrade instead of starting a test");
        state["targets"][0]["supported"] = true; state["retryAfterMs"] = 10; Require(!CanStart(state), "A start during cooldown must be disabled");
        state["retryAfterMs"] = 0; state["job"]["state"] = "running"; state["busy"] = true;
        state["job"]["progress"] = {{"phase", "download"}, {"elapsedMs", 10000}, {"durationMs", 20000}, {"bytes", 1000000}, {"maxBytes", MaxBytes}, {"bytesPerSecond", 400000}};
        const auto progress = ViewProgress(state);
        Require(!progress.marquee && progress.position == 250 && progress.text.find(L"A 下载 B → A") != std::wstring::npos, "Download progress and global A perspective must be explicit");
        Require(Rate(Speed(state, safe, "download")) == L"3.20 Mbps", "Live measured rate must override the preceding report");
        state["job"]["progress"] = {{"phase", "connecting"}}; Require(ViewProgress(state).marquee, "Progress without a denominator must remain indeterminate");
        state["job"]["progress"] = {{"phase", "connecting"}, {"elapsedMs", 1000}, {"durationMs", MaximumMs}}; Require(ViewProgress(state).marquee, "Connecting deadlines are not transfer progress");
        state["job"]["progress"] = {{"phase", "upload"}, {"elapsedMs", 20000}, {"durationMs", 20000}, {"waitingForReceiver", true}, {"confirmationRemainingMs", 3200}};
        Require(ViewProgress(state).marquee && ViewProgress(state).text.find(L"等待接收端确认") != std::wstring::npos && ViewProgress(state).text.find(L"3.2") != std::wstring::npos, "Receiver confirmation must be clearly labelled and bounded instead of showing successful completion");
        state["job"]["progress"]["waitingForReceiver"] = false;
        Require(!ViewProgress(state).marquee && ViewProgress(state).position == 990 && ViewProgress(state).text.find(L"2/2") != std::wstring::npos, "A full sending interval cannot imply receiver-confirmed completion");
        state["job"]["progress"] = {{"phase", "upload"}, {"latencyMs", 264.3}, {"samplesDone", 32}};
        Require(Latency(state, safe).value == 264.3 && SamplesLabel(state, safe).find(L"32 个样本") != std::wstring::npos, "Loaded RTT must refresh during transfers and support more than five samples");
        state["job"]["progress"] = {{"phase", "download"}, {"waitingForReceiver", true}};
        Require(Speed(state, safe, "download").value == 2000000, "A receiver-confirmation update without a rate must retain the actual received measurement");
        report["stopReason"] = "receiver-timeout";
        Require(Details(state, Report(report)).find(L"等待接收端确认超时") != std::wstring::npos, "Receiver timeout needs a precise failure reason");
        report["latency"]["samples"] = Json::array(); report["latency"]["failedSamples"] = 2;
        Require(Report(report)["latency"].is_object() && Report(report)["latency"]["medianMs"].is_null(), "Missing loaded RTT must remain unknown instead of invalidating the bulk measurements");
        report["latency"]["samples"] = std::vector<double>(64, 100.0); report["latency"]["failedSamples"] = 0;
        Require(Report(report)["latency"]["samples"].size() == 64, "The continuous loaded-RTT plan permits sixty-four bounded samples");
        report["latency"]["samples"].push_back(100.0);
        Require(Report(report)["latency"].is_null(), "Oversized RTT histories must not pass report export validation");
        report["latency"]["samples"] = Json::array({123.0});
        Require(Details(state, Report(report)).find(L"20 秒") != std::wstring::npos && Details(state, Report(report)).find(L"512 MiB") != std::wstring::npos, "The native window must describe the new transfer interval and traffic cap");
        state["job"]["state"] = "cancelled"; Require(ViewProgress(state).position != 1000, "Cancellation cannot show successful completion");
        report["download"]["completion"] = "failed"; safe = Report(report); Require(!Speed(Json::object(), safe, "download").known, "A failed stage must not invent zero throughput");
        report["download"]["receivedBytes"] = MaxBytes + 1; Require(Report(report)["download"].is_null(), "Oversized transfer counters must not be exported");
        Require(!Numeric({{"x", std::numeric_limits<double>::infinity()}}, "x", 1e9).known && Report(Json()).is_null() && !CanStart(Json()), "Malformed state must be unavailable");

        OwnedJobs ownership; const auto first = ownership.BeginView();
        Require(!ownership.Register("my-job", first) && !ownership.ClaimCancel("remote-job"), "Only this window's start can own an auto-cancelled task");
        Require(ownership.Retire().size() == 1 && ownership.ClaimCancel("my-job") && !ownership.ClaimCancel("my-job"), "Closing must schedule one bounded cancellation");
        ownership.FinishCancel("my-job", true);
        const auto second = ownership.BeginView(); ownership.Retire();
        Require(ownership.Register("late-start", second) && ownership.ClaimCancel("late-start"), "A POST reply received after closing must still be cancelled");
        ownership.FinishCancel("late-start", true);
        const auto third = ownership.BeginView(); ownership.Register("old", third); ownership.Register("new", third);
        Require(!ownership.ClaimCancel("old"), "Only the backend's current retained task can remain owned");
        ownership.ObserveOnly("remote-job"); Require(ownership.Retire().empty() && !ownership.ClaimCancel("remote-job"), "Remote-started tasks must not be cancelled on window close");
        StatusEpoch status;
        const auto beforePost = status.Capture(); status.Started(); const auto duringPost = status.Capture();
        Require(!status.Accept(beforePost) && status.Accept(duringPost), "Starting a command must invalidate snapshots captured before it");
        status.Settled();
        Require(!status.Accept(duringPost) && status.Accept(status.Capture()), "A late GET captured during POST must not overwrite its successful job reply");
        const auto beforeFailedCancel = status.Capture(); status.Started(); const auto duringFailedCancel = status.Capture(); status.Settled();
        Require(!status.Accept(beforeFailedCancel) && !status.Accept(duringFailedCancel), "Failed command replies must also retire old GET snapshots");
        std::cout << "Speed-test units, report whitelist, progress and owned-job lifecycle passed\n"; return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
