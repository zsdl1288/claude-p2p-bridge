#pragma once
#include "platform.hpp"

// Different API ports must not share one profile. A directory's Windows file
// identity is unchanged by case, dot segments, short names or junction aliases.
class DataDirectoryLock {
    KernelHandle mutex_;
    bool acquired_ = false;
    static std::wstring Name(const fs::path& directory) {
        KernelHandle handle(CreateFileW(directory.c_str(), FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
            OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr));
        if (handle.value == INVALID_HANDLE_VALUE) throw std::runtime_error(WindowsError("读取数据目录标识"));
        BY_HANDLE_FILE_INFORMATION info{};
        if (!GetFileInformationByHandle(handle.value, &info)) throw std::runtime_error(WindowsError("读取数据目录标识"));
        if (!(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) throw std::runtime_error("客户端数据路径必须是目录");
        std::wostringstream name;
        name << L"Local\\ClaudeBridge.Profile." << std::hex << info.dwVolumeSerialNumber
             << L'.' << info.nFileIndexHigh << L'.' << info.nFileIndexLow;
        return name.str();
    }
public:
    explicit DataDirectoryLock(const fs::path& directory) {
        auto name = Name(directory);
        HANDLE handle = CreateMutexW(nullptr, FALSE, name.c_str());
        DWORD result = GetLastError();
        if (!handle) throw std::runtime_error(WindowsError("保护客户端数据目录"));
        mutex_.reset(handle);
        acquired_ = result != ERROR_ALREADY_EXISTS;
        // A rejected contender must not extend the owner's lock lifetime.
        if (!acquired_) mutex_.reset();
    }
    bool Acquired() const { return acquired_; }
};
