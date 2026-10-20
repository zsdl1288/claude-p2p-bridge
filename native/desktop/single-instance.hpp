#pragma once
#include "platform.hpp"
#include <sddl.h>

namespace DesktopSingleInstance {
struct Names {
    std::wstring mutexPrefix = L"Global\\ClaudeBridge.Desktop.SingleInstance.";
    std::wstring windowClass = L"ClaudeBridge.Desktop.SingleInstance";
    std::wstring legacyPrefix = L"ClaudeBridge.Desktop.";
};

inline Names TestNames(const std::wstring& name) {
    // This is a source-level dependency injection point for test executables.
    // The shipped desktop has no argument or environment override for it.
    if (name.empty() || name.find_first_not_of(L"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-") != std::wstring::npos)
        throw std::runtime_error("Invalid desktop test namespace");
    return {L"Global\\ClaudeBridge.Desktop.Test." + name + L".", L"ClaudeBridge.Desktop.Test." + name, L""};
}

inline std::wstring ProcessSid(HANDLE process) {
    KernelHandle token;
    if (!OpenProcessToken(process, TOKEN_QUERY, &token.value)) throw std::runtime_error(WindowsError("读取 Windows 用户身份"));
    DWORD bytes = 0; GetTokenInformation(token.value, TokenUser, nullptr, 0, &bytes);
    if (!bytes) throw std::runtime_error(WindowsError("读取 Windows 用户 SID 大小"));
    std::vector<unsigned char> buffer(bytes);
    if (!GetTokenInformation(token.value, TokenUser, buffer.data(), bytes, &bytes)) throw std::runtime_error(WindowsError("读取 Windows 用户 SID"));
    LPWSTR text = nullptr;
    if (!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(buffer.data())->User.Sid, &text)) throw std::runtime_error(WindowsError("转换 Windows 用户 SID"));
    std::wstring sid(text); LocalFree(text); return sid;
}

inline bool LegacyClass(const std::wstring& actual, const std::wstring& prefix) {
    if (prefix.empty() || !actual.starts_with(prefix)) return false;
    auto suffix = actual.substr(prefix.size());
    return !suffix.empty() && suffix.find_first_not_of(L"0123456789") == std::wstring::npos;
}

inline HWND FindExisting(const Names& names, const std::wstring& sid, const std::wstring& title) {
    struct Search { const Names& names; const std::wstring& sid; const std::wstring& title; HWND found = nullptr; } search{names, sid, title};
    EnumWindows([](HWND window, LPARAM parameter) -> BOOL {
        auto& search = *reinterpret_cast<Search*>(parameter);
        wchar_t buffer[256]; int length = GetClassNameW(window, buffer, 256);
        const std::wstring type(buffer, std::max(0, length));
        if (type != search.names.windowClass && !LegacyClass(type, search.names.legacyPrefix)) return TRUE;
        if (ControlText(window) != search.title) return TRUE;
        DWORD pid = 0; GetWindowThreadProcessId(window, &pid);
        if (!pid || pid == GetCurrentProcessId()) return TRUE;
        KernelHandle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
        if (!process.value) return TRUE;
        try { if (ProcessSid(process.value) != search.sid) return TRUE; }
        catch (...) { return TRUE; }
        search.found = window; return FALSE;
    }, reinterpret_cast<LPARAM>(&search));
    return search.found;
}

inline void Activate(HWND window, UINT restoreMessage) {
    DWORD pid = 0; GetWindowThreadProcessId(window, &pid);
    if (pid) AllowSetForegroundWindow(pid);
    PostMessageW(window, restoreMessage, 0, 0);
}

class Instance {
    Names names_; std::wstring sid_; KernelHandle mutex_; bool owned_ = false;
    bool Open() {
        mutex_.reset(CreateMutexExW(nullptr, (names_.mutexPrefix + sid_).c_str(), 0,
                                   SYNCHRONIZE | MUTEX_MODIFY_STATE));
        if (mutex_.value) return true;
        // A same-user elevated instance or an older lock with a narrower DACL
        // may deny a writable handle. It still owns the identity: discover its
        // window, or retry after it exits, without starting a second engine.
        if (GetLastError() == ERROR_ACCESS_DENIED) return false;
        throw std::runtime_error(WindowsError("创建当前用户单实例锁"));
    }
public:
    explicit Instance(Names names = {}) : names_(std::move(names)), sid_(ProcessSid(GetCurrentProcess())) {
        Open();
    }
    ~Instance() { if (owned_) ReleaseMutex(mutex_.value); }
    Instance(const Instance&) = delete; Instance& operator=(const Instance&) = delete;
    bool TryAcquire() {
        if (owned_) return true;
        if (!mutex_.value && !Open()) return false;
        const DWORD result = WaitForSingleObject(mutex_.value, 0);
        if (result == WAIT_OBJECT_0 || result == WAIT_ABANDONED) return owned_ = true;
        if (result != WAIT_TIMEOUT) throw std::runtime_error(WindowsError("获取当前用户单实例锁"));
        return false;
    }
    HWND Existing(const std::wstring& title) const { return FindExisting(names_, sid_, title); }
    const Names& Naming() const { return names_; }
    std::wstring JobName() const { return names_.mutexPrefix + sid_ + L".Job"; }
    // A first launch may own the lock before its HWND exists. Wait for either
    // that HWND or its early exit, and take over an abandoned lock safely.
    bool AcquireOrActivate(bool minimized, const std::wstring& title, UINT restoreMessage, unsigned waitMs = 10000) {
        const auto started = GetTickCount64();
        for (;;) {
            if (TryAcquire()) {
                if (auto existing = Existing(title)) { if (!minimized) Activate(existing, restoreMessage); return false; }
                return true;
            }
            if (auto existing = Existing(title)) { if (!minimized) Activate(existing, restoreMessage); return false; }
            if (GetTickCount64() - started >= waitMs) return false;
            Sleep(50);
        }
    }
};
}
