#include "../native/desktop/startup.hpp"
#include <iostream>

int wmain(int argc, wchar_t** argv) {
    if (argc != 2) return 2;
    const auto root = fs::absolute(argv[1]);
    const auto key = L"Software\\ClaudeBridge.Tests\\Update-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64());
    try {
        fs::create_directories(root / L"profile");
        const auto oldFile = root / L"old.exe", newerFile = root / L"new.exe";
        { std::ofstream out(oldFile, std::ios::binary); out << "old-test-executable"; }
        { std::ofstream out(newerFile, std::ios::binary); out << "new-test-executable"; }
        DesktopStartup::Registration registration(root / L"profile", 3210, false, key, L"Fixture");
        if (registration.RefreshAfterUpdate(newerFile, L"1.2.12") || registration.Enabled()) throw std::runtime_error("Update enabled disabled startup");
        const auto initial = registration.Enable(oldFile, L"1.2.11");
        fs::copy_file(newerFile, initial, fs::copy_options::overwrite_existing);
        if (registration.RefreshIfNewer(initial, L"1.2.12")) throw std::runtime_error("Ordinary startup refreshed in-place copy");
        if (!registration.RefreshAfterUpdate(initial, L"1.2.12")) throw std::runtime_error("Updated startup copy was not migrated");
        const auto updated = registration.OwnedTarget();
        if (!updated || updated->parent_path().filename().wstring().find(L"1.2.12-") != 0 ||
            DesktopStartup::ReadExecutable(*updated) != DesktopStartup::ReadExecutable(newerFile)) throw std::runtime_error("Updated startup target is wrong");
        DesktopStartup::Registration other(root / L"different-profile", 3210, false, key, L"Fixture");
        const auto before = registration.Read();
        if (other.RefreshAfterUpdate(newerFile, L"1.2.13") || registration.Read() != before) throw std::runtime_error("Update changed another profile startup");
        registration.Disable();
        if (registration.RefreshAfterUpdate(newerFile, L"1.2.13") || registration.Enabled()) throw std::runtime_error("Update restored disabled startup");
        RegDeleteTreeW(HKEY_CURRENT_USER, key.c_str());
        std::cout << "PASS: acknowledged in-place update migrates only owned enabled startup; profile and disabled entries preserved.\n";
        return 0;
    } catch (const std::exception& error) {
        RegDeleteTreeW(HKEY_CURRENT_USER, key.c_str());
        std::cerr << error.what() << '\n'; return 1;
    }
}
