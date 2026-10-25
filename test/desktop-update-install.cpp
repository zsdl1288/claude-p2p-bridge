#include "../native/desktop/update-release.hpp"
#include "../native/desktop/update-install.hpp"

namespace DesktopUpdate {
inline Json InstallFixtureSource() {
    wchar_t file[32768]{};
    const auto length = GetEnvironmentVariableW(L"BRIDGE_UPDATE_INSTALL_FIXTURE", file, 32768);
    if (!length || length >= 32768) throw std::runtime_error("Missing isolated update installation fixture");
    std::ifstream input{fs::path(file)};
    if (!input) throw std::runtime_error("Cannot read isolated update installation fixture");
    Json source; input >> source; return source;
}
inline Json InstallFixtureCheckRelease(const std::string& currentVersion, const std::atomic<bool>& cancel) {
    if (cancel) throw std::runtime_error("更新已取消");
    return ParseRelease(InstallFixtureSource().at("release"), currentVersion);
}
inline fs::path InstallFixtureDownloadRelease(const Json& release, const fs::path& staging,
        const std::atomic<bool>& cancel, const std::function<void(uint64_t, uint64_t)>& progress) {
    const auto candidate = fs::path(Wide(InstallFixtureSource().at("candidate").get<std::string>()));
    // Only replace the remote byte source. The real stream bounds, cancellation,
    // SHA-256, PE architecture, version checks and staging rename remain active.
    return ReleaseDetail::Download(release, staging, cancel, progress,
        [&](const std::string&, uint64_t, ReleaseDetail::Budget& budget, const ReleaseDetail::Sink& sink) {
            std::ifstream input(candidate, std::ios::binary);
            if (!input) throw std::runtime_error("Cannot read isolated candidate executable");
            std::array<char, 65536> buffer{};
            while (input) {
                budget.Check(); input.read(buffer.data(), buffer.size());
                if (const auto count = input.gcount(); count > 0) sink(buffer.data(), static_cast<size_t>(count));
            }
            if (!input.eof()) throw std::runtime_error("Cannot finish isolated candidate read");
        });
}
} // namespace DesktopUpdate

// Source-only fixture: production main, helper, replacement, readiness and
// embedded engine run unchanged. Released builds have neither these stubs nor
// a runtime override for their repository, download source or instance lock.
#define CheckRelease InstallFixtureCheckRelease
#define DownloadRelease InstallFixtureDownloadRelease
#include "../native/desktop/main.cpp"
