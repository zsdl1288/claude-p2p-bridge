#pragma once
#include "platform.hpp"
#include <array>
#include <cstdio>
#include <exception>
#include <cstdlib>

// Lifecycle diagnostics contain fixed event labels and numeric facts only.
// Keep the fatal path independent of the ordinary logger's mutex/allocator.
namespace DesktopLifecycle {
inline std::string UtcNow() {
    SYSTEMTIME time{}; GetSystemTime(&time);
    char text[32]; std::snprintf(text, sizeof(text), "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ",
        time.wYear, time.wMonth, time.wDay, time.wHour, time.wMinute, time.wSecond, time.wMilliseconds);
    return text;
}
inline bool Label(const std::string& text) {
    return !text.empty() && text.size() <= 96 && text.find_first_not_of(
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.") == std::string::npos;
}
inline uint64_t CreationTime(HANDLE process) {
    FILETIME created{}, exited{}, kernel{}, user{};
    if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) return 0;
    return (uint64_t{created.dwHighDateTime} << 32) | created.dwLowDateTime;
}
class Journal;
inline Journal* activeJournal = nullptr;
class Journal {
    fs::path directory_;
    std::vector<std::unique_ptr<KernelHandle>> directories_;
    std::mutex mutex_;
    KernelHandle crash_;
    std::string session_, version_, startedUtc_;
    uint64_t created_ = 0, startTick_ = 0;
    size_t maxBytes_;
    bool started_ = false, finished_ = false, hooks_ = false;
    LONG fatalWritten_ = 0;
    std::array<char, 256> fatalSuffix_{};
    LPTOP_LEVEL_EXCEPTION_FILTER previousFilter_ = nullptr;
    std::terminate_handler previousTerminate_ = nullptr;

    bool PinDirectory(const fs::path& path) {
        auto handle = std::make_unique<KernelHandle>(CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        BY_HANDLE_FILE_INFORMATION info{};
        if (handle->value == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(handle->value, &info)
            || !(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) return false;
        directories_.push_back(std::move(handle)); return true;
    }
    bool PrepareDirectory(const fs::path& data) {
        auto absolute = fs::absolute(data).lexically_normal();
        auto current = absolute.root_path();
        if (current.empty() || !PinDirectory(current)) return false;
        for (const auto& part : absolute.relative_path()) {
            current /= part; if (!PinDirectory(current)) return false;
        }
        for (const auto* name : {L"diagnostics", L"lifecycle"}) {
            current /= name;
            if (!CreateDirectoryW(current.c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS) return false;
            if (!PinDirectory(current)) return false;
        }
        directory_ = current; return true;
    }
    HANDLE OpenRegular(const fs::path& path, DWORD access, DWORD creation = OPEN_ALWAYS) const {
        HANDLE handle = CreateFileW(path.c_str(), access | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, creation, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
        if (handle == INVALID_HANDLE_VALUE) return nullptr;
        BY_HANDLE_FILE_INFORMATION info{};
        if (GetFileType(handle) != FILE_TYPE_DISK || !GetFileInformationByHandle(handle, &info)
            || (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) || info.nNumberOfLinks != 1) {
            CloseHandle(handle); return nullptr;
        }
        return handle;
    }
    bool SafeExisting(const fs::path& path) const {
        const DWORD attributes = GetFileAttributesW(path.c_str());
        if (attributes == INVALID_FILE_ATTRIBUTES) return GetLastError() == ERROR_FILE_NOT_FOUND || GetLastError() == ERROR_PATH_NOT_FOUND;
        KernelHandle file(OpenRegular(path, FILE_READ_ATTRIBUTES, OPEN_EXISTING)); return file.value != nullptr;
    }
    bool Rotate(const fs::path& path, size_t incoming) {
        KernelHandle file(OpenRegular(path, FILE_READ_ATTRIBUTES));
        if (!file.value) return false;
        LARGE_INTEGER size{}; if (!GetFileSizeEx(file.value, &size)) return false;
        file.reset();
        if (size.QuadPart == 0 || uint64_t(size.QuadPart) + incoming <= maxBytes_) return true;
        const fs::path one(path.wstring() + L".1"), two(path.wstring() + L".2");
        if (!SafeExisting(one) || !SafeExisting(two)) return false;
        if (GetFileAttributesW(one.c_str()) != INVALID_FILE_ATTRIBUTES
            && !MoveFileExW(one.c_str(), two.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) return false;
        return MoveFileExW(path.c_str(), one.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != FALSE;
    }
    bool Write(HANDLE file, const std::string& text) const {
        DWORD written = 0;
        return WriteFile(file, text.data(), static_cast<DWORD>(text.size()), &written, nullptr)
            && written == text.size() && FlushFileBuffers(file);
    }
    Json State() const {
        return {{"v", 1}, {"sessionId", session_}, {"pid", GetCurrentProcessId()}, {"version", version_},
            {"startedAtUtc", startedUtc_}, {"createdFileTime", std::to_string(created_)}, {"completed", false}};
    }
    bool WriteState(const Json& value) {
        auto target = directory_ / L"desktop-state.json";
        auto temporary = directory_ / L"desktop-state.tmp";
        if (!SafeExisting(target)) return false;
        KernelHandle file(OpenRegular(temporary, GENERIC_WRITE)); if (!file.value) return false;
        LARGE_INTEGER zero{};
        if (!SetFilePointerEx(file.value, zero, nullptr, FILE_BEGIN) || !Write(file.value, value.dump() + "\n") || !SetEndOfFile(file.value)
            || !FlushFileBuffers(file.value)) return false;
        file.reset();
        return MoveFileExW(temporary.c_str(), target.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != FALSE;
    }
    void PreviousSession() {
        KernelHandle file(OpenRegular(directory_ / L"desktop-state.json", GENERIC_READ, OPEN_EXISTING));
        if (!file.value) return;
        char buffer[4097]; DWORD bytes = 0;
        if (!ReadFile(file.value, buffer, sizeof(buffer), &bytes, nullptr) || !bytes || bytes > 4096) return;
        auto previous = Json::parse(buffer, buffer + bytes, nullptr, false);
        if (!previous.is_object() || previous.value("v", 0) != 1 || !previous.contains("completed") || !previous["completed"].is_boolean()
            || previous["completed"].get<bool>() || !previous.contains("pid") || !previous["pid"].is_number_unsigned()) return;
        const DWORD pid = previous["pid"].get<DWORD>();
        // PID reuse cannot make an unrelated process look like the old session.
        KernelHandle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
        bool unknown = !process.value && GetLastError() != ERROR_INVALID_PARAMETER;
        const auto oldCreated = previous.value("createdFileTime", std::string{});
        if (process.value && oldCreated == std::to_string(CreationTime(process.value))
            && WaitForSingleObject(process.value, 0) == WAIT_TIMEOUT) unknown = true;
        Json fields{{"reason", unknown ? "previous-process-state-unavailable" : "no-completion-record"}, {"previousPid", pid}};
        if (previous.contains("sessionId") && previous["sessionId"].is_string() && Label(previous["sessionId"])) fields["previousSessionId"] = previous["sessionId"];
        if (previous.contains("version") && previous["version"].is_string() && Label(previous["version"])) fields["previousVersion"] = previous["version"];
        Event(unknown ? "previous-session-unknown" : "previous-session-incomplete", fields);
    }
    void Fatal(const char* reason, DWORD code, const void* address) noexcept {
        if (!crash_.value || InterlockedExchange(&fatalWritten_, 1)) return;
        SYSTEMTIME time{}; GetSystemTime(&time);
        char line[768];
        int length = std::snprintf(line, sizeof(line),
            "{\"v\":1,\"utc\":\"%04u-%02u-%02uT%02u:%02u:%02u.%03uZ\",\"event\":\"fatal\",\"reason\":\"%s\",\"exceptionCode\":%lu,\"exceptionAddress\":%llu,%s\n",
            time.wYear, time.wMonth, time.wDay, time.wHour, time.wMinute, time.wSecond, time.wMilliseconds,
            reason, static_cast<unsigned long>(code), static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(address)), fatalSuffix_.data());
        if (length > 0 && static_cast<size_t>(length) < sizeof(line)) {
            DWORD written; WriteFile(crash_.value, line, static_cast<DWORD>(length), &written, nullptr); FlushFileBuffers(crash_.value);
        }
    }
    static LONG WINAPI ExceptionFilter(EXCEPTION_POINTERS* exception) {
        if (activeJournal) activeJournal->Fatal("windows-unhandled-exception",
            exception && exception->ExceptionRecord ? exception->ExceptionRecord->ExceptionCode : 0,
            exception && exception->ExceptionRecord ? exception->ExceptionRecord->ExceptionAddress : nullptr);
        return EXCEPTION_CONTINUE_SEARCH;
    }
    static void Terminate() noexcept {
        if (activeJournal) activeJournal->Fatal("cpp-terminate", 0xE0000001, nullptr);
        std::abort();
    }
public:
    explicit Journal(size_t maxBytes = 512 * 1024) : maxBytes_(std::max(size_t{512}, maxBytes)) {}
    ~Journal() {
        if (activeJournal == this) {
            activeJournal = nullptr;
            if (hooks_) { SetUnhandledExceptionFilter(previousFilter_); std::set_terminate(previousTerminate_); }
        }
    }
    Journal(const Journal&) = delete; Journal& operator=(const Journal&) = delete;
    bool Started() const { return started_; }
    std::string SessionId() const { return session_; }
    bool Start(const fs::path& dataDirectory, const std::string& version) noexcept {
        try {
            if (started_) return true;
            unsigned char nonce[16]; if (BCryptGenRandom(nullptr, nonce, sizeof(nonce), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) return false;
            static constexpr char hex[] = "0123456789abcdef";
            for (auto value : nonce) { session_ += hex[value >> 4]; session_ += hex[value & 15]; }
            version_ = Label(version) ? version : "unknown"; startedUtc_ = UtcNow();
            created_ = CreationTime(GetCurrentProcess()); startTick_ = GetTickCount64();
            SetEnvironmentVariableW(L"BRIDGE_LIFECYCLE_SESSION", Wide(session_).c_str());
            SetEnvironmentVariableW(L"BRIDGE_LIFECYCLE_DIRECTORY", fs::absolute(dataDirectory).c_str());
            if (!PrepareDirectory(dataDirectory)) return false;
            if (!Rotate(directory_ / L"desktop-crash.jsonl", 768)) return false;
            crash_.reset(OpenRegular(directory_ / L"desktop-crash.jsonl", FILE_APPEND_DATA)); if (!crash_.value) return false;
            std::snprintf(fatalSuffix_.data(), fatalSuffix_.size(), "\"component\":\"desktop\",\"pid\":%lu,\"sessionId\":\"%s\",\"version\":\"%s\"}",
                static_cast<unsigned long>(GetCurrentProcessId()), session_.c_str(), version_.c_str());
            // Fail closed for diagnostics if even the ordinary journal cannot
            // be opened. Never claim a successfully recorded session otherwise.
            { KernelHandle ordinary(OpenRegular(directory_ / L"desktop.jsonl", FILE_APPEND_DATA)); if (!ordinary.value) return false; }
            started_ = true;
            try { PreviousSession(); } catch (...) { Event("previous-state-unreadable"); }
            if (!WriteState(State())) { started_ = false; return false; }
            activeJournal = this; previousFilter_ = SetUnhandledExceptionFilter(ExceptionFilter);
            previousTerminate_ = std::set_terminate(Terminate); hooks_ = true;
            Event("session-started"); return true;
        } catch (...) { started_ = false; return false; }
    }
    void Event(const char* event, const Json& details = Json::object()) noexcept {
        try {
            if (!started_ || !event || !Label(event)) return;
            std::lock_guard lock(mutex_);
            Json row{{"v", 1}, {"utc", UtcNow()}, {"component", "desktop"}, {"pid", GetCurrentProcessId()},
                {"sessionId", session_}, {"version", version_}, {"event", event}};
            for (const auto* name : {"reason", "phase", "previousSessionId", "previousVersion"})
                if (details.contains(name) && details[name].is_string() && Label(details[name])) row[name] = details[name];
            for (const auto* name : {"childPid", "exitCode", "win32Code", "flags", "previousPid", "durationMs"})
                if (details.contains(name) && (details[name].is_number_unsigned() || (details[name].is_number_integer() && details[name].get<int64_t>() >= 0))) row[name] = details[name];
            for (const auto* name : {"expected", "forced"}) if (details.contains(name) && details[name].is_boolean()) row[name] = details[name];
            const auto line = row.dump() + "\n";
            if (!Rotate(directory_ / L"desktop.jsonl", line.size())) return;
            KernelHandle file(OpenRegular(directory_ / L"desktop.jsonl", FILE_APPEND_DATA));
            if (file.value) Write(file.value, line);
        } catch (...) { /* Diagnostics never prevent starting or shutting down. */ }
    }
    void Finish(const char* reason, DWORD exitCode) noexcept {
        try {
            if (!started_ || finished_) return;
            const std::string safeReason = reason && Label(reason) ? reason : "unspecified-exit";
            Event("session-ended", {{"reason", safeReason}, {"exitCode", exitCode}, {"durationMs", GetTickCount64() - startTick_}});
            auto state = State(); state["completed"] = true; state["reason"] = safeReason;
            state["exitCode"] = exitCode; state["endedAtUtc"] = UtcNow();
            std::lock_guard lock(mutex_); if (WriteState(state)) finished_ = true;
        } catch (...) {}
    }
};
}
