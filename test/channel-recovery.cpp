#include "../native/desktop/channel-recovery.hpp"
#include <iostream>

void Require(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }

int main() {
    try {
        using namespace DesktopChannelRecovery;
        Json state = {{"enabled", true}, {"mode", "notify"}, {"state", "monitoring"}, {"cooldownMs", 0}, {"notice", nullptr},
            {"lastReason", "download-stall"}, {"lastResult", "refreshed"}, {"lastRefreshAgoMs", 100}};
        const auto monitoring = Summary(state, "client");
        Require(monitoring == L"后台监测中，持续卡顿时会提示刷新" && monitoring.find(L"已") == std::wstring::npos, "Legacy last-result fields must not claim an automatic action or attach a previous result to the current connection");
        state["notice"] = {{"id", 1}, {"phase", "suggested"}, {"ageMs", 0}, {"result", nullptr}, {"private", "private-do-not-show"}};
        Require(Suggested(state) && Summary(state, "client") == L"通道持续受阻，建议点击“刷新线路”", "A current confirmed suggestion must direct the user to the existing manual button");
        const auto suggested = state;
        for (const auto& invalid : {Json(-1), Json(0), Json("1"), Json(1.5), Json(9007199254740992ULL)}) {
            state = suggested; state["notice"]["id"] = invalid;
            Require(!Suggested(state) && Summary(state, "client") == monitoring, "An unsafe suggestion ID must fail closed");
        }
        for (const auto& invalid : {Json(-1), Json(300001), Json("0"), Json(0.5)}) {
            state = suggested; state["notice"]["ageMs"] = invalid;
            Require(!Suggested(state) && Summary(state, "client") == monitoring, "Expired or malformed notices must not prompt a manual refresh");
        }
        state = suggested; state["notice"]["ageMs"] = 300000;
        Require(Suggested(state), "The documented five-minute notice boundary should be accepted");
        state["notice"]["phase"] = "private-phase"; Require(!Suggested(state) && Summary(state, "client").find(L"private") == std::wstring::npos, "Backend text outside the phase whitelist cannot leak into the UI");
        state = suggested; state["notice"]["result"] = "refreshed";
        Require(!Suggested(state) && Summary(state, "client") == monitoring, "A contradictory suggested-result combination cannot imply a user action");
        for (const auto* phase : {"refreshing", "refreshed", "failed"}) {
            state = suggested; state["notice"]["phase"] = phase;
            Require(Summary(state, "client") == monitoring, "Non-suggestion historical notices must not duplicate or invent manual results");
        }
        state = suggested;
        Require(Summary(state, "client", true) == L"正在按请求刷新线路，现有配对保留", "A manual start must immediately take precedence over a previous suggestion");
        state["state"] = "refreshing";
        Require(Summary(state, "client") == L"正在重新探测 Bridge 通道", "Transport work without a captured manual request cannot be mislabeled as an automatic improvement");
        state["state"] = "cooldown"; state["cooldownMs"] = 120000;
        Require(Summary(state, "client").find(L"120秒后可刷新") != std::wstring::npos, "A suggestion during a shared cooldown must not direct the user to a disabled action");
        state["cooldownMs"] = 1; Require(Cooldown(state) == L"1秒", "A nonzero shared cooldown must round up");
        for (const auto& invalid : {Json(-1), Json(120001), Json("123"), Json(true)}) {
            state["cooldownMs"] = invalid; Require(Cooldown(state).empty(), "Malformed cooldown values cannot be displayed as measured time");
        }
        state["state"] = "budget-exhausted"; state["notice"] = nullptr;
        Require(Summary(state, "client") == L"刷新额度暂满（30分钟最多3次）", "Budget exhaustion has a bounded fixed explanation without a fabricated countdown");
        state = suggested;
        Require(Summary(state, "host") == L"后台监测共享通道，由对应调用端决定刷新", "B cannot claim it automatically refreshed an A or show an A's local result");
        state["enabled"] = false;
        Require(Summary(state, "client").find(L"不可用") != std::wstring::npos && Summary(state, "host").find(L"不可用") != std::wstring::npos, "A stale suggestion must not claim monitoring when the embedded monitor is disabled");
        state = suggested; state["mode"] = "auto";
        Require(Summary(state, "client") == L"通道监测：等待状态更新", "A missing or legacy mode cannot be described as the newly selected notification-only behavior");
        std::cout << "Native channel monitoring notification and safe status tests passed\n";
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
