#include "../native/desktop/update-release.hpp"
#include "../native/desktop/update-install.hpp"

namespace DesktopUpdate {
inline void FixtureSignalUpdateReady(const std::wstring& name) {
    if (!ValidReadyEvent(name)) throw std::runtime_error("Invalid isolated ready event");
    KernelHandle ready(OpenEventW(EVENT_MODIFY_STATE, FALSE, name.c_str()));
    if (!ready.value || !SetEvent(ready.value)) throw std::runtime_error("Missing isolated ready event");
}
inline std::string FixtureMode() {
    wchar_t file[32768]{};
    const auto length = GetEnvironmentVariableW(L"BRIDGE_UPDATE_UI_FIXTURE", file, 32768);
    if (!length || length >= 32768) throw std::runtime_error("Missing isolated updater fixture");
    std::ifstream input{fs::path(file)}; std::string mode; input >> mode; return mode;
}
inline Json FixtureCheckRelease(const std::string&, const std::atomic<bool>& cancel) {
    if (FixtureMode() == "check-cancel") {
        while (!cancel) Sleep(10);
        throw std::runtime_error("已取消检查");
    }
    if (FixtureMode() == "latest") return Json();
    if (FixtureMode() == "error") throw std::runtime_error("模拟网络不可用");
    return {{"version", "99.0.0"}, {"tag", "v99.0.0"}, {"name", "ClaudeBridge-99.0.0-windows-x64.exe"},
        {"url", "https://github.com/zsdl1288/claude-p2p-bridge/releases/download/v99.0.0/ClaudeBridge-99.0.0-windows-x64.exe"},
        {"size", 1000}, {"sha256", std::string(64, 'a')}};
}
inline fs::path FixtureDownloadRelease(const Json&, const fs::path&, const std::atomic<bool>& cancel,
        const std::function<void(uint64_t, uint64_t)>& progress) {
    progress(500, 1000);
    if (FixtureMode() == "download-cancel") {
        while (!cancel) Sleep(10);
        throw std::runtime_error("已取消下载");
    }
    throw std::runtime_error("模拟文件校验失败");
}
}
// Production Application and window handlers, with source-only network stubs.
// No runtime setting or environment override exists in the released updater.
#define CheckRelease FixtureCheckRelease
#define DownloadRelease FixtureDownloadRelease
#define SignalUpdateReady FixtureSignalUpdateReady
#include "../native/desktop/main.cpp"
