#pragma once
#include "platform.hpp"
#include <array>
#include <optional>

// A per-user Run entry launches a stable copy, so moving the downloaded EXE
// does not break login startup. Tests inject an isolated, non-Run registry key.
namespace DesktopStartup {
inline constexpr wchar_t RUN_KEY[] = L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";
inline constexpr wchar_t RUN_VALUE[] = L"ClaudeBridge";

struct RegistryKey {
    HKEY value = nullptr;
    ~RegistryKey() { if (value) RegCloseKey(value); }
};

inline std::wstring NormalizedPath(const fs::path& value) {
    auto normalized = fs::absolute(value).lexically_normal().wstring();
    std::replace(normalized.begin(), normalized.end(), L'/', L'\\');
    while (normalized.size() > 3 && normalized.back() == L'\\') normalized.pop_back();
    return normalized;
}
inline bool SamePath(const fs::path& a, const fs::path& b) {
    return _wcsicmp(NormalizedPath(a).c_str(), NormalizedPath(b).c_str()) == 0;
}
inline fs::path ExecutablePath() {
    std::vector<wchar_t> buffer(32768);
    DWORD size = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (!size || size == buffer.size()) throw std::runtime_error("无法读取客户端文件路径");
    return fs::path(std::wstring(buffer.data(), size));
}
inline std::vector<unsigned char> ReadExecutable(const fs::path& path) {
    auto size = fs::file_size(path);
    if (!size || size > 512 * 1024 * 1024) throw std::runtime_error("客户端文件大小无效");
    std::vector<unsigned char> bytes(static_cast<size_t>(size));
    std::ifstream file(path, std::ios::binary);
    if (!file.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(bytes.size())))
        throw std::runtime_error("无法读取客户端文件");
    return bytes;
}
inline std::array<unsigned long, 3> VersionParts(const std::wstring& version) {
    std::array<unsigned long, 3> result{}; size_t begin = 0;
    for (size_t i = 0; i < result.size(); ++i) {
        auto end = version.find(L'.', begin);
        auto part = version.substr(begin, end == std::wstring::npos ? end : end - begin);
        if (part.empty() || part.find_first_not_of(L"0123456789") != std::wstring::npos)
            throw std::runtime_error("客户端版本号无效");
        result[i] = std::stoul(part);
        if (i < 2 && end == std::wstring::npos) throw std::runtime_error("客户端版本号无效");
        if (i == 2 && end != std::wstring::npos) throw std::runtime_error("客户端版本号无效");
        begin = end == std::wstring::npos ? version.size() : end + 1;
    }
    return result;
}
inline std::wstring Command(const fs::path& executable, const fs::path& directory, int port, bool system) {
    auto command = QuoteArgument(executable.wstring()) + L" --minimized --port " + std::to_wstring(port)
                 + L" --data-dir " + QuoteArgument(directory.wstring());
    if (system) command += L" --system-tailscale";
    // Microsoft documents a 260-character limit for Run value commands.
    if (command.size() > 260) throw std::runtime_error("数据目录路径过长，无法设置开机启动，请使用较短的数据目录");
    return command;
}

class Registration {
    fs::path directory_; int port_; bool system_;
    std::wstring key_, name_;
    void Check(LSTATUS status, const char* operation) const {
        if (status != ERROR_SUCCESS) throw std::runtime_error(std::string(operation) + " (Windows " + std::to_string(status) + ")");
    }
public:
    Registration(fs::path directory, int port, bool system,
                 std::wstring key = RUN_KEY, std::wstring name = RUN_VALUE)
        : directory_(fs::absolute(directory).lexically_normal()), port_(port), system_(system), key_(std::move(key)), name_(std::move(name)) {}
    std::wstring Read() const {
        RegistryKey handle;
        auto result = RegOpenKeyExW(HKEY_CURRENT_USER, key_.c_str(), 0, KEY_QUERY_VALUE, &handle.value);
        if (result == ERROR_FILE_NOT_FOUND) return {};
        Check(result, "读取开机启动设置");
        DWORD type = 0, size = 0;
        result = RegQueryValueExW(handle.value, name_.c_str(), nullptr, &type, nullptr, &size);
        if (result == ERROR_FILE_NOT_FOUND) return {};
        Check(result, "读取开机启动设置");
        if (type != REG_SZ || size < sizeof(wchar_t) || size > 32768 || size % sizeof(wchar_t)) return {};
        std::vector<wchar_t> value(size / sizeof(wchar_t) + 1, L'\0');
        Check(RegQueryValueExW(handle.value, name_.c_str(), nullptr, &type, reinterpret_cast<BYTE*>(value.data()), &size), "读取开机启动设置");
        if (type != REG_SZ) return {};
        return value.data();
    }
    std::optional<fs::path> OwnedTarget() const {
        auto text = Read(); if (text.empty()) return std::nullopt;
        int count = 0; auto arguments = CommandLineToArgvW(text.c_str(), &count);
        if (!arguments) return std::nullopt;
        std::unique_ptr<wchar_t*, decltype(&LocalFree)> allocation(arguments, LocalFree);
        if (count != (system_ ? 7 : 6) || std::wstring(arguments[1]) != L"--minimized"
            || std::wstring(arguments[2]) != L"--port" || std::wstring(arguments[3]) != std::to_wstring(port_)
            || std::wstring(arguments[4]) != L"--data-dir" || !SamePath(arguments[5], directory_)
            || (system_ && std::wstring(arguments[6]) != L"--system-tailscale")) return std::nullopt;
        fs::path target(arguments[0]);
        if (target.filename() != L"ClaudeBridge.exe" || !SamePath(target.parent_path().parent_path(), directory_ / L"app")) return std::nullopt;
        return target;
    }
    bool Enabled() const { auto target = OwnedTarget(); return target.has_value() && fs::is_regular_file(*target); }
    fs::path Enable(const fs::path& executable, const std::wstring& version) const {
        VersionParts(version);
        auto bytes = ReadExecutable(executable); auto digest = Sha256(bytes.data(), bytes.size());
        auto directory = directory_ / L"app" / (version + L"-" + Wide(digest.substr(0, 20)));
        auto target = directory / L"ClaudeBridge.exe";
        auto command = Command(target, directory_, port_, system_);
        bool matches = false;
        if (fs::is_regular_file(target) && fs::file_size(target) == bytes.size()) {
            auto current = ReadExecutable(target); matches = Sha256(current.data(), current.size()) == digest;
        }
        if (!matches) {
            fs::create_directories(directory);
            auto temporary = directory / (L"startup-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64()) + L".tmp");
            try {
                fs::copy_file(executable, temporary, fs::copy_options::none);
                auto copied = ReadExecutable(temporary);
                if (Sha256(copied.data(), copied.size()) != digest) throw std::runtime_error("自启动客户端副本校验失败");
                if (!MoveFileExW(temporary.c_str(), target.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
                    throw std::runtime_error(WindowsError("保存自启动客户端"));
            } catch (...) { std::error_code error; fs::remove(temporary, error); throw; }
        }
        RegistryKey handle;
        Check(RegCreateKeyExW(HKEY_CURRENT_USER, key_.c_str(), 0, nullptr, 0, KEY_SET_VALUE, nullptr, &handle.value, nullptr), "保存开机启动设置");
        Check(RegSetValueExW(handle.value, name_.c_str(), 0, REG_SZ, reinterpret_cast<const BYTE*>(command.c_str()), static_cast<DWORD>((command.size() + 1) * sizeof(wchar_t))), "保存开机启动设置");
        return target;
    }
    void Disable() const {
        // An unrelated instance using a different data directory owns its setting.
        if (!OwnedTarget()) return;
        RegistryKey handle;
        Check(RegOpenKeyExW(HKEY_CURRENT_USER, key_.c_str(), 0, KEY_SET_VALUE, &handle.value), "修改开机启动设置");
        auto result = RegDeleteValueW(handle.value, name_.c_str());
        if (result != ERROR_FILE_NOT_FOUND) Check(result, "关闭开机启动");
    }
    bool RefreshIfNewer(const fs::path& executable, const std::wstring& version) const {
        auto target = OwnedTarget(); if (!target || SamePath(executable, *target)) return false;
        // A background copy from an earlier build must never rewrite the entry
        // that a newly launched portable client just updated.
        if (SamePath(executable.parent_path().parent_path(), directory_ / L"app")) return false;
        auto folder = target->parent_path().filename().wstring(); auto split = folder.find(L'-');
        if (split == std::wstring::npos) return false;
        try { if (VersionParts(version) < VersionParts(folder.substr(0, split))) return false; }
        catch (...) { return false; }
        auto updated = Enable(executable, version);
        return !SamePath(updated, *target);
    }
    bool RefreshAfterUpdate(const fs::path& executable, const std::wstring& version) const {
        const auto target = OwnedTarget();
        if (!target) return false;
        // The updater preserves the launch path, including an old app/<version>
        // startup copy. Only an acknowledged update may migrate that same-path
        // copy into the new version/hash directory. Never enable a disabled or
        // another profile's startup entry.
        if (!SamePath(executable, *target)) return RefreshIfNewer(executable, version);
        const auto updated = Enable(executable, version);
        return !SamePath(updated, *target);
    }
};
}
