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

        Json multi = {{"receivedBytes", 4000000}, {"durationMs", 2000}, {"bytesPerSecond", 999999999}, {"completion", "complete"}, {"limitReached", false}, {"streams", Json::array()}};
        for (unsigned index = 0; index < 4; ++index) multi["streams"].push_back({{"index", index}, {"receivedBytes", 1000000}, {"durationMs", 1000 + index * 250},
            {"completion", "complete"}, {"limitReached", false}, {"ticket", "private-multi-ticket"}});
        Require(MultiTransfer(multi)["bytesPerSecond"] == 2000000 && MultiTransfer(multi).dump().find("private-") == std::string::npos,
            "Multi TCP must use total bytes/common wall time and whitelist stream evidence");
        auto invalidMulti = multi; invalidMulti["streams"][3]["completion"] = "partial";
        Require(MultiTransfer(invalidMulti).is_null(), "Complete multi TCP requires all four streams confirmed");
        invalidMulti["completion"] = "partial"; Require(MultiTransfer(invalidMulti).is_object(), "Partial multi measurements must survive cancellation");
        invalidMulti = multi; invalidMulti["durationMs"] = 500; Require(MultiTransfer(invalidMulti).is_null(), "Common duration cannot be shorter than a stream");
        invalidMulti = multi; invalidMulti["receivedBytes"] = 4000001; Require(MultiTransfer(invalidMulti).is_null(), "Aggregate bytes must match stream sum");
        invalidMulti = multi; invalidMulti["streams"][3]["index"] = 2; Require(MultiTransfer(invalidMulti).is_null(), "Duplicate stream indices cannot be exported");
        Json multiReport = {{"v", 4}, {"transport", "native-tailscale"}, {"completed", false}, {"targetRole", "host"}, {"maximumSeconds", 150}, {"maxBytesPerDirection", MultiMaxBytes},
            {"download", {{"receivedBytes", 1000000}, {"durationMs", 1000}, {"bytesPerSecond", 1000000}, {"completion", "complete"}, {"limitReached", false}}},
            {"tcpMulti", {{"connections", 4}, {"download", multi}, {"upload", nullptr}}}};
        const auto multiSafe = Report(multiReport);
        Require(multiSafe["tcpMulti"]["download"]["bytesPerSecond"] == 2000000 && multiSafe["tcpMultiMaxBytesPerDirection"] == MultiTCPMaxBytes,
            "Version four report must preserve separate TCP modes and total budget");
        Require(MultiComparison(multiSafe, "download") == L"单连接的 2.00 倍", "Only complete comparable TCP results should show a ratio");
        auto claimedMulti = multiReport; claimedMulti["completed"] = true;
        Require(Report(claimedMulti)["completed"] == false, "Missing six-stage evidence cannot retain a completed flag");
        Json multiState = {{"transport", "native-tailscale"}, {"job", {{"id", "multi-job"}, {"state", "running"}, {"report", multiReport},
            {"progress", {{"phase", "multi-download"}, {"elapsedMs", 5000}, {"durationMs", 10000}, {"bytesPerSecond", 3000000}}}}}};
        Require(MultiSpeed(multiState, multiSafe, "download").value == 3000000 && Speed(multiState, multiSafe, "download").value == 1000000,
            "Multi progress must not overwrite the single connection result");
        Require(MultiLabel(multiState, multiSafe, "download") == L"测速中", "A live multi phase must not display a final comparison");
        Require(ViewProgress(multiState).position == 416 && ViewProgress(multiState).text.find(L"3/6") != std::wstring::npos &&
            Details(multiState, multiSafe).find(L"2432 MiB") != std::wstring::npos, "Six phases and increased overall budget must be visible");

        Json tcpStages = Json::array();
        const unsigned durations[] = {1000, 1000, 4000, 2000, 8000};
        for (unsigned i = 0; i < 5; ++i) {
            Json stage = {{"index", i}, {"connections", TCPConnectionCounts[i]}, {"receivedBytes", TCPConnectionCounts[i] * 1024}, {"durationMs", durations[i]},
                {"bytesPerSecond", 999}, {"completion", "complete"}, {"limitReached", false}, {"streams", Json::array()}};
            for (unsigned stream = 0; stream < TCPConnectionCounts[i]; ++stream) stage["streams"].push_back({{"index", stream}, {"receivedBytes", 1024}, {"durationMs", durations[i]}, {"completion", "complete"}, {"limitReached", false}});
            tcpStages.push_back(stage);
        }
        Json tcpRamp = {{"completion", "complete"}, {"stages", tcpStages}, {"bestStageIndex", 4}, {"totalReceivedBytes", 999}, {"stopReason", "completed"}};
        Require(AdaptiveTCP(tcpRamp)["bestStageIndex"] == 3 && BestTCP(AdaptiveTCP(tcpRamp))["connections"] == 8,
            "The highest complete TCP stage may use fewer than sixteen connections");
        Require(AdaptiveTCP(tcpRamp)["totalReceivedBytes"] == 31 * 1024, "TCP adaptive total must be recomputed from actual stages");
        auto badRamp = tcpRamp; badRamp["stages"][1]["connections"] = 4; Require(AdaptiveTCP(badRamp).is_null(), "TCP stage count must follow the fixed increasing plan");
        badRamp = tcpRamp; badRamp["stages"][4]["streams"].erase(15); Require(AdaptiveTCP(badRamp).is_null(), "A sixteen-stream confirmation must contain every stream");
        auto partialRamp = tcpRamp; partialRamp["stages"].erase(4); partialRamp["completion"] = "partial"; partialRamp["stopReason"] = "cancelled";
        Require(AdaptiveTCP(partialRamp)["bestStageIndex"] == 3, "Cancelling later stages must retain the previous confirmed best");
        Json rampReport = {{"v", 5}, {"transport", "native-tailscale"}, {"completed", false}, {"targetRole", "host"}, {"maximumSeconds", 210}, {"maxBytesPerDirection", RampMaxBytes},
            {"tcpMulti", {{"mode", "adaptive"}, {"connectionCounts", Json::array({1, 2, 4, 8, 16})}, {"download", partialRamp}, {"upload", nullptr}}}, {"download", multiReport["download"]}};
        const auto rampSafe = Report(rampReport);
        Require(rampSafe["download"]["bytesPerSecond"] == 1024 && rampSafe["tcpStageMaxBytes"] == TCPStageMaxBytes,
            "Single connection baseline must be the first TCP stage, not an independent injected summary");
        Json rampState = multiState; rampState["job"]["report"] = rampReport; rampState["job"]["progress"]["stageIndex"] = 4;
        Require(MultiSpeed(rampState, rampSafe, "download").value == 4096 && MultiLabel(rampState, rampSafe, "download").find(L"8 条连接") != std::wstring::npos,
            "Current partial stage rate cannot replace the confirmed best or its connection count");
        Require(ViewProgress(rampState).position == 225 && Details(rampState, rampSafe).find(L"2944 MiB") != std::wstring::npos,
            "Adaptive TCP has five nested steps and the correct overall traffic budget");
        Json idleNative = {{"transport", "native-tailscale"}};
        Require(Ramp(idleNative) && Multi(idleNative) && Details(idleNative, Json()).find(L"210 秒 / 2944 MiB") != std::wstring::npos,
            "A new native test window must explain the current plan before starting any traffic");

        auto plateauTCP = [](const std::vector<uint64_t>& rates, const std::string& stop = "plateau") -> Json {
            Json stages = Json::array();
            for (size_t index = 0; index < rates.size(); ++index) {
                const auto connections = TCPConnectionCounts[index];
                Json stage = {{"index", index}, {"connections", connections}, {"receivedBytes", rates[index]}, {"durationMs", 1000},
                    {"bytesPerSecond", 999}, {"completion", "complete"}, {"limitReached", false}, {"streams", Json::array()}};
                for (unsigned stream = 0; stream < connections; ++stream) stage["streams"].push_back({{"index", stream},
                    {"receivedBytes", rates[index] / connections + (stream < rates[index] % connections ? 1 : 0)},
                    {"durationMs", 1000}, {"completion", "complete"}, {"limitReached", false}});
                stages.push_back(stage);
            }
            return {{"completion", "complete"}, {"stages", stages}, {"bestStageIndex", 99}, {"totalReceivedBytes", 999}, {"stopReason", stop}};
        };
        const auto plateauInput = plateauTCP({100000, 104000, 108000}), plateauSafe = AdaptiveTCP(plateauInput, true);
        Require(plateauSafe.is_object() && plateauSafe["completion"] == "complete" && plateauSafe["bestStageIndex"] == 2 &&
            plateauSafe["stages"][2]["bytesPerSecond"] == 108000, "Small gains must update the real best even when consecutive low gains trigger plateau");
        Require(AdaptiveTCP(plateauTCP({100000, 100000, 90000}), true)["bestStageIndex"] == 0, "Equal and declining stages count toward plateau while ties keep fewer connections");
        Require(AdaptiveTCP(plateauTCP({100000, 104000, 109200, 110000, 110000}, "completed"), true).is_object(),
            "An exact five-percent gain resets history and a fifth stage takes completed precedence");
        Require(AdaptiveTCP(plateauTCP({0, 0, 0, 0, 0}, "completed"), true).is_object(), "A zero prior best must not manufacture plateau evidence");
        for (const auto& invalid : {plateauTCP({100000, 100000}), plateauTCP({100000, 105000, 110250}), plateauTCP({0, 0, 0}),
            plateauTCP({100000, 104000, 108000, 200000}), plateauTCP({100000, 104000, 108000, 200000, 400000}, "completed"),
            plateauTCP({100000, 110000, 120000, 120000, 120000})})
            Require(AdaptiveTCP(invalid, true).is_null(), "Forged or delayed plateau stops cannot pass desktop export validation");
        auto plateauPartial = plateauInput; plateauPartial["completion"] = "partial"; plateauPartial["stopReason"] = "cancelled";
        plateauPartial["stages"][2]["completion"] = "partial";
        for (auto& stream : plateauPartial["stages"][2]["streams"]) stream["completion"] = "partial";
        Require(AdaptiveTCP(plateauPartial, true)["bestStageIndex"] == 1 && AdaptiveTCP(plateauPartial, true)["completion"] == "partial",
            "A cancelled partial stage cannot trigger plateau or replace the confirmed best");
        plateauPartial["completion"] = "complete"; plateauPartial["stopReason"] = "plateau";
        Require(AdaptiveTCP(plateauPartial, true).is_null(), "Unknown or partial measurements cannot prove plateau completion");
        auto historicalFlat = plateauTCP({100000, 100000, 100000, 100000, 100000}, "completed");
        Require(AdaptiveTCP(historicalFlat).is_object() && AdaptiveTCP(historicalFlat, true).is_null(),
            "Historical v5 still accepts all five stages without applying a newer early-stop policy");
        auto plateauReport = rampReport; plateauReport["v"] = 6;
        plateauReport["tcpMulti"] = {{"mode", "adaptive"}, {"connectionCounts", Json::array({1, 2, 4, 8, 16})},
            {"earlyStop", {{"minimumGainPercent", 5}, {"consecutiveStages", 2}}}, {"download", plateauInput}, {"upload", plateauInput}};
        const auto plateauReportSafe = Report(plateauReport);
        Require(plateauReportSafe["tcpMulti"]["download"]["completion"] == "complete" && plateauReportSafe["tcpMulti"]["earlyStop"]["minimumGainPercent"] == 5,
            "Version six exports must preserve their validated early-stop policy and normal plateau completion");
        const auto plateauLabel = MultiLabel(Json::object(), plateauReportSafe, "download"), plateauText = Details(Json::object(), plateauReportSafe);
        Require(plateauLabel == L"4连接 · 提前结束3/5" && plateauLabel.find(L"五档完成") == std::wstring::npos &&
            plateauText.find(L"提升不足提前结束 · 已测 3/5 档") != std::wstring::npos && plateauText.find(L"尚未完成全部档位") == std::wstring::npos,
            "A legal plateau must show its reason and tested stage count without claiming five stages or an incomplete test");
        Require(Plateau(idleNative) && Details(idleNative, Json()).find(L"连续两次提升不足 5%") != std::wstring::npos &&
            !Plateau(Json::object(), rampSafe) && Details(Json::object(), rampSafe).find(L"连续两次提升不足") == std::wstring::npos,
            "An idle native window uses the new policy while historical v5 keeps its original explanation");
        auto badPolicy = plateauReport; badPolicy["tcpMulti"]["earlyStop"]["minimumGainPercent"] = "5";
        Require(Report(badPolicy)["tcpMulti"]["download"].is_null(), "Malformed policy values must be unavailable, not throw or silently enable early stopping");
        Require(Reason({{"reason", "unsupported"}}).find(L"1.2.11") != std::wstring::npos, "Desktop upgrade guidance must name the current compatible release");

        Json nativeUDP = {{"receivedBytes", 99000}, {"durationMs", 1000}, {"bytesPerSecond", 1}, {"completion", "complete"}, {"limitReached", false},
            {"sentBytes", 110000}, {"sentPackets", 100}, {"receivedPackets", 90}, {"lostPackets", 0}, {"lossPercent", 0},
            {"duplicatePackets", 3}, {"outOfOrderPackets", 4}, {"offeredBytesPerSecond", 6250000}, {"packetBytes", 1100}, {"ticket", "private-native-ticket"}};
        Json nativeReport = {{"v", 2}, {"transport", "native-tailscale"}, {"completed", false}, {"targetRole", "host"},
            {"maximumSeconds", 60}, {"maxBytesPerDirection", MaxBytes}, {"udp", {{"download", nativeUDP}, {"upload", nullptr}}}};
        const auto nativeSafe = Report(nativeReport);
        Require(nativeSafe["udp"]["download"]["bytesPerSecond"] == 99000 && nativeSafe["udp"]["download"]["lossPercent"] == 10 &&
            nativeSafe["udp"]["download"]["lostPackets"] == 10, "UDP must use actual unique received bytes and confirmed sent-packet counts");
        Require(nativeSafe.dump().find("private-native-ticket") == std::string::npos, "Native reports must not export authentication tickets");
        nativeUDP["completion"] = "partial"; nativeUDP["lossPercent"] = nullptr; nativeUDP["lostPackets"] = nullptr;
        Require(UDPTransfer(nativeUDP)["lossPercent"].is_null(), "Missing UDP confirmation must not become zero percent packet loss");
        nativeUDP["completion"] = "complete"; nativeUDP["sentPackets"] = 89;
        Require(UDPTransfer(nativeUDP).is_null(), "UDP receiver counts cannot exceed confirmed sender counts");
        Json nativeState = {{"transport", "native-tailscale"}, {"job", {{"id", "native-job"}, {"state", "running"}, {"report", nativeReport},
            {"progress", {{"phase", "udp-download"}, {"elapsedMs", 4000}, {"durationMs", 8000}, {"bytesPerSecond", 6250000}}}}}};
        Require(ViewProgress(nativeState).position == 625 && ViewProgress(nativeState).text.find(L"3/4") != std::wstring::npos,
            "Native UDP must have a separate third phase instead of completing after TCP");
        Require(!Speed(nativeState, nativeSafe, "download").known, "UDP progress cannot appear as TCP download speed");
        const auto nativeDetails = Details(nativeState, nativeSafe);
        Require(nativeDetails.find(L"0.79 Mbps") != std::wstring::npos && nativeDetails.find(L"10.00%") != std::wstring::npos &&
            nativeDetails.find(L"不代表最大带宽") != std::wstring::npos, "Native details must show measured UDP goodput, loss and offered-load scope");

        auto adaptiveStage = [](unsigned index, double targetMbps, uint64_t sent, uint64_t received) -> Json {
            return {{"index", index}, {"targetBytesPerSecond", targetMbps * 1e6 / 8}, {"offeredBytesPerSecond", targetMbps * 1e6 / 8},
                {"sentBytes", sent * 1100}, {"sentPackets", sent}, {"receivedBytes", received * 1100}, {"receivedPackets", received},
                {"durationMs", 1500}, {"senderDurationMs", 1500}, {"senderBytesPerSecond", 999}, {"bytesPerSecond", 999},
                {"lostPackets", sent - received}, {"lossPercent", (sent - received) * 100.0 / sent}, {"duplicatePackets", 0}, {"outOfOrderPackets", 0},
                {"packetBytes", 1100}, {"completion", "complete"}, {"limitReached", false}, {"assessment", "passed"}, {"targetReached", true}};
        };
        Json adaptive = {{"mode", "adaptive"}, {"completion", "complete"}, {"stopReason", "loss-limited"},
            {"stages", Json::array({adaptiveStage(0, 10, 1500, 1500), adaptiveStage(1, 20, 3000, 2700)})},
            {"lowLossStageIndex", 99}, {"peakStageIndex", 99}, {"ticket", "private-adaptive-ticket"}};
        const auto adaptiveSafe = AdaptiveUDP(adaptive);
        Require(adaptiveSafe["lowLossStageIndex"] == 0 && adaptiveSafe["peakStageIndex"] == 1 &&
            adaptiveSafe["stages"][0]["bytesPerSecond"] == 1100000 && adaptiveSafe["stages"][1]["bytesPerSecond"] == 1980000 &&
            adaptiveSafe["stages"][1]["lossPercent"] == 10, "Adaptive summary must select actual received rates and their matching loss instead of targets");
        Require(adaptiveSafe["stages"][1]["senderBytesPerSecond"] == 2200000 && adaptiveSafe["totalSentBytes"] == 4950000,
            "Actual sender rate and total traffic must come from stage measurements");
        Require(adaptiveSafe.dump().find("private-adaptive-ticket") == std::string::npos && !adaptiveSafe.contains("bytesPerSecond"),
            "Adaptive reports must not leak private data or invent an aggregate bandwidth");
        Json constrained = adaptive; constrained["stages"] = Json::array({adaptiveStage(0, 20, 1500, 1500)}); constrained["stopReason"] = "sender-limited";
        Require(AdaptiveUDP(constrained)["lowLossStageIndex"] == 0 && AdaptiveUDP(constrained)["lowerBound"] == true,
            "Sender-limited stages still establish their actual low-loss measured rate");
        constrained["stages"] = Json::array({adaptiveStage(0, 0.25, 42, 42)});
        Require(AdaptiveUDP(constrained).is_object(), "Weak links must allow the two downward refinements below one Mbps");
        Json adaptiveReport = {{"v", 3}, {"transport", "native-tailscale"}, {"completed", true}, {"targetRole", "host"},
            {"maximumSeconds", 120}, {"maxBytesPerDirection", AdaptiveMaxBytes}, {"udp", {{"download", adaptive}, {"upload", constrained}}}};
        const auto safeAdaptiveReport = Report(adaptiveReport);
        auto completePlateau = plateauReport; completePlateau["completed"] = true; completePlateau["udp"] = safeAdaptiveReport["udp"];
        Require(Report(completePlateau)["completed"] == true, "Two validated plateau directions plus complete UDP are a normally completed report");
        Require(safeAdaptiveReport["udpMaxBytesPerDirection"] == AdaptiveUDPMaxBytes && safeAdaptiveReport["udpSecondsPerDirection"] == 30,
            "Adaptive report bounds must match the production budget");
        const auto adaptiveText = Details(Json::object(), safeAdaptiveReport);
        Require(adaptiveText.find(L"8.80 Mbps") != std::wstring::npos && adaptiveText.find(L"15.84 Mbps") != std::wstring::npos &&
            adaptiveText.find(L"10.00%") != std::wstring::npos && adaptiveText.find(L"已测下界") != std::wstring::npos,
            "Desktop details must show low-loss and peak rates with corresponding loss and limit explanation");
        auto partialStage = adaptiveStage(2, 100, 20000, 20000); partialStage["completion"] = "partial"; partialStage["sentBytes"] = nullptr;
        partialStage["sentPackets"] = nullptr; partialStage["senderDurationMs"] = nullptr; partialStage["lostPackets"] = nullptr; partialStage["lossPercent"] = nullptr;
        adaptive["stages"].push_back(partialStage); adaptive["completion"] = "partial"; adaptive["stopReason"] = "cancelled";
        Require(AdaptiveUDP(adaptive)["peakStageIndex"] == 1 && AdaptiveUDP(adaptive)["stages"][2]["senderBytesPerSecond"].is_null(),
            "Unconfirmed stages must never enter peak or low-loss summaries");
        adaptive["stages"][2]["receivedBytes"] = 0; adaptive["stages"][2]["receivedPackets"] = 0;
        adaptive["stages"][2]["durationMs"] = 0; adaptive["stages"][2]["bytesPerSecond"] = nullptr;
        Require(AdaptiveUDP(adaptive)["peakStageIndex"] == 1 && AdaptiveUDP(adaptive)["lowLossStageIndex"] == 0 &&
            AdaptiveUDP(adaptive)["stages"][2]["bytesPerSecond"].is_null(),
            "A new unmeasured stage must retain the earlier completed results instead of clearing the direction");

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
