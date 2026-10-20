#include "startup.hpp"
#include "profile-lock.hpp"
#include <iostream>

namespace {
void Require(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }
void Write(const fs::path& path, const std::string& bytes) {
    std::ofstream output(path, std::ios::binary | std::ios::trunc); output << bytes;
    if (!output) throw std::runtime_error("fixture write failed");
}
struct IsolatedRegistry {
    std::wstring path = L"Software\\ClaudeBridge\\Tests\\Startup." + std::to_wstring(GetCurrentProcessId());
    ~IsolatedRegistry() { RegDeleteTreeW(HKEY_CURRENT_USER, path.c_str()); }
};
}

int wmain(int count, wchar_t** args) {
    try {
        Require(count == 2, "pass a dedicated workspace fixture directory");
        auto root = fs::absolute(args[1]); fs::create_directories(root);
        auto profile = root / L"profile"; auto separate = root / L"separate";
        fs::create_directories(profile); fs::create_directories(separate);
        auto firstProfile = std::make_unique<DataDirectoryLock>(profile);
        Require(firstProfile->Acquired(), "first profile instance should acquire its directory lock");
        DataDirectoryLock sameProfile(root / L"profile" / L".." / L"profile");
        Require(!sameProfile.Acquired(), "dot-segment alias bypassed the profile lock");
        DataDirectoryLock caseAlias(root / L"PROFILE");
        Require(!caseAlias.Acquired(), "case alias bypassed the profile lock");
        DataDirectoryLock otherProfile(separate);
        Require(otherProfile.Acquired(), "separate profile directories should run independently");
        firstProfile.reset();
        DataDirectoryLock reopenedProfile(profile);
        Require(reopenedProfile.Acquired(), "profile lock was not released automatically, or rejected contender retained it");
        auto source = root / L"Downloaded client.exe"; Write(source, "first executable fixture");
        auto data = root / L"user data";
        IsolatedRegistry registry;
        DesktopStartup::Registration registration(data, 3210, false, registry.path, L"TestClient");
        Require(registration.Read().empty() && !registration.Enabled(), "initial startup should be absent");
        auto target = registration.Enable(source, L"0.6.0");
        Require(registration.Enabled(), "startup registration should be enabled");
        Require(DesktopStartup::SamePath(*registration.OwnedTarget(), target), "registration should own stable copy");
        Require(registration.Read() == DesktopStartup::Command(target, data, 3210, false), "startup command differs");
        auto bytes = DesktopStartup::ReadExecutable(target);
        Require(std::string(bytes.begin(), bytes.end()) == "first executable fixture", "stable copy contents differ");
        fs::remove(source);
        Require(registration.Enabled() && fs::is_regular_file(target), "moving download must not break startup");
        Require(!registration.RefreshIfNewer(target, L"0.6.0"), "stable startup copy should not copy itself");
        fs::remove(target);
        Require(!registration.Enabled() && registration.OwnedTarget().has_value(), "a missing stable copy must not appear enabled");
        Write(source, "first executable fixture");
        Require(!registration.RefreshIfNewer(source, L"0.6.0") && registration.Enabled(), "manual launch should repair a missing registered copy");

        auto initial = registration.Read();
        DesktopStartup::Registration unrelated(root / L"another data", 3210, false, registry.path, L"TestClient");
        Require(!unrelated.Enabled(), "another data directory must not own startup");
        unrelated.Disable(); Require(registration.Read() == initial, "another data directory removed startup");
        DesktopStartup::Registration otherPort(data, 3212, false, registry.path, L"TestClient");
        otherPort.Disable(); Require(registration.Read() == initial, "another port removed startup");
        DesktopStartup::Registration otherMode(data, 3210, true, registry.path, L"TestClient");
        otherMode.Disable(); Require(registration.Read() == initial, "another network mode removed startup");

        Write(source, "second executable fixture");
        Require(registration.RefreshIfNewer(source, L"0.7.0"), "newer manual client should refresh startup");
        auto updated = registration.Read(); Require(updated != initial, "new version registration unchanged");
        Require(!registration.RefreshIfNewer(target, L"0.6.0"), "older client must not downgrade startup");
        Require(!registration.RefreshIfNewer(target, L"0.7.0"), "another stable background copy must not rewrite startup");
        Require(registration.Read() == updated, "older startup changed registration");
        auto newerTarget = *registration.OwnedTarget(); Write(newerTarget, "corrupt copy");
        registration.Enable(source, L"0.7.0");
        auto repaired = DesktopStartup::ReadExecutable(newerTarget);
        Require(std::string(repaired.begin(), repaired.end()) == "second executable fixture", "corrupt stable copy not repaired");
        bool invalidVersion = false;
        try { registration.Enable(source, L"0.7.0/../invalid"); } catch (...) { invalidVersion = true; }
        Require(invalidVersion && registration.Read() == updated, "invalid versions must not change the existing registration");
        registration.Disable(); Require(registration.Read().empty() && !registration.Enabled(), "disable did not remove own setting");

        DesktopStartup::Registration system(data, 3210, true, registry.path, L"TestSystem");
        system.Enable(source, L"0.6.0");
        Require(system.Enabled() && system.Read().ends_with(L" --system-tailscale"), "system Tailscale flag missing");
        system.Disable(); Require(system.Read().empty(), "system-mode setting not removed");

        auto command = DesktopStartup::Command(L"C:\\Program Files\\ClaudeBridge.exe", L"C:\\folder with spaces\\", 3210, false);
        int arguments = 0; auto parsed = CommandLineToArgvW(command.c_str(), &arguments);
        Require(parsed && arguments == 6, "quoted command failed to parse");
        std::unique_ptr<wchar_t*, decltype(&LocalFree)> allocation(parsed, LocalFree);
        Require(std::wstring(parsed[0]) == L"C:\\Program Files\\ClaudeBridge.exe", "executable quoting changed path");
        Require(std::wstring(parsed[5]) == L"C:\\folder with spaces\\", "trailing backslash quoting changed path");
        bool rejected = false;
        try { DesktopStartup::Command(source, root / std::wstring(250, L'x'), 3210, false); } catch (...) { rejected = true; }
        Require(rejected, "overlong Run command should be rejected");
        std::cout << "startup: profile lock aliases/release, stable copy, quoting, isolated HKCU registry, upgrades, mode ownership and removal passed\n";
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
