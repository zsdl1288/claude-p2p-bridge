#pragma once
#include "platform.hpp"
#include <array>
#include <cctype>
#include <functional>
#include <limits>

namespace DesktopUpdate {
inline constexpr uint64_t MaximumExecutableBytes = 512ull * 1024 * 1024;

inline bool ParseVersion(const std::string& value, std::array<unsigned, 3>& result) {
    size_t position = 0;
    for (size_t part = 0; part < result.size(); ++part) {
        const auto start = position;
        unsigned number = 0;
        while (position < value.size() && value[position] >= '0' && value[position] <= '9') {
            number = number * 10 + static_cast<unsigned>(value[position++] - '0');
            if (number > 65535) return false;
        }
        if (position == start || (position - start > 1 && value[start] == '0')) return false;
        result[part] = number;
        if (part != 2 && (position >= value.size() || value[position++] != '.')) return false;
    }
    return position == value.size();
}

inline bool ValidHash(const std::string& value) {
    return value.size() == 64 && std::all_of(value.begin(), value.end(), [](unsigned char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
    });
}

namespace VerifyDetail {
class Hash {
    BCRYPT_ALG_HANDLE algorithm_ = nullptr;
    BCRYPT_HASH_HANDLE hash_ = nullptr;
    std::vector<unsigned char> object_;
public:
    Hash() {
        if (BCryptOpenAlgorithmProvider(&algorithm_, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0)
            throw std::runtime_error("无法初始化更新文件校验");
        DWORD size = 0, received = 0;
        if (BCryptGetProperty(algorithm_, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&size), sizeof(size), &received, 0) < 0
            || received != sizeof(size) || !size) { BCryptCloseAlgorithmProvider(algorithm_, 0); algorithm_ = nullptr; throw std::runtime_error("无法初始化更新文件校验"); }
        object_.resize(size);
        if (BCryptCreateHash(algorithm_, &hash_, object_.data(), size, nullptr, 0, 0) < 0) {
            BCryptCloseAlgorithmProvider(algorithm_, 0); algorithm_ = nullptr; throw std::runtime_error("无法初始化更新文件校验");
        }
    }
    ~Hash() { if (hash_) BCryptDestroyHash(hash_); if (algorithm_) BCryptCloseAlgorithmProvider(algorithm_, 0); }
    Hash(const Hash&) = delete;
    Hash& operator=(const Hash&) = delete;
    void Add(const void* data, DWORD count) {
        if (BCryptHashData(hash_, reinterpret_cast<PUCHAR>(const_cast<void*>(data)), count, 0) < 0)
            throw std::runtime_error("更新文件校验失败");
    }
    std::string Finish() {
        unsigned char digest[32];
        if (BCryptFinishHash(hash_, digest, sizeof(digest), 0) < 0) throw std::runtime_error("更新文件校验失败");
        std::ostringstream output; output << std::hex << std::setfill('0');
        for (const auto byte : digest) output << std::setw(2) << static_cast<unsigned>(byte);
        return output.str();
    }
};

inline uint64_t FileSize(HANDLE file) {
    BY_HANDLE_FILE_INFORMATION info{};
    LARGE_INTEGER size{};
    if (!GetFileInformationByHandle(file, &info) || (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))
        || GetFileType(file) != FILE_TYPE_DISK || !GetFileSizeEx(file, &size) || size.QuadPart <= 0
        || static_cast<uint64_t>(size.QuadPart) > MaximumExecutableBytes)
        throw std::runtime_error("更新文件类型或大小无效");
    return static_cast<uint64_t>(size.QuadPart);
}

inline HANDLE OpenLocked(const fs::path& path) {
    HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                              FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
    if (file == INVALID_HANDLE_VALUE) throw std::runtime_error("无法读取或锁定更新文件");
    return file;
}

inline void ReadAt(HANDLE file, uint64_t offset, void* data, DWORD count, uint64_t size) {
    if (offset > size || count > size - offset) throw std::runtime_error("更新文件不是有效的 Windows 程序");
    LARGE_INTEGER position{}; position.QuadPart = static_cast<LONGLONG>(offset); DWORD received = 0;
    if (!SetFilePointerEx(file, position, nullptr, FILE_BEGIN) || !ReadFile(file, data, count, &received, nullptr) || received != count)
        throw std::runtime_error("无法读取更新文件");
}

inline std::string FileHash(HANDLE file, const std::function<void()>& check = {}) {
    const auto size = FileSize(file);
    LARGE_INTEGER zero{};
    if (!SetFilePointerEx(file, zero, nullptr, FILE_BEGIN)) throw std::runtime_error("无法读取更新文件");
    Hash hash; std::array<unsigned char, 65536> buffer{}; uint64_t total = 0;
    for (;;) {
        if (check) check();
        DWORD received = 0;
        if (!ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &received, nullptr)) throw std::runtime_error("无法读取更新文件");
        if (!received) break;
        total += received;
        if (total > size) throw std::runtime_error("校验时更新文件大小发生变化");
        hash.Add(buffer.data(), received);
    }
    if (total != size) throw std::runtime_error("更新文件不完整");
    return hash.Finish();
}

inline void Executable(HANDLE file, const fs::path& path, const std::string& version) {
    std::array<unsigned, 3> expected{};
    if (!ParseVersion(version, expected)) throw std::runtime_error("更新版本号无效");
    const auto size = FileSize(file);
    IMAGE_DOS_HEADER dos{}; ReadAt(file, 0, &dos, sizeof(dos), size);
    if (dos.e_magic != IMAGE_DOS_SIGNATURE || dos.e_lfanew < static_cast<LONG>(sizeof(dos))) throw std::runtime_error("更新文件不是有效的 Windows 程序");
    DWORD signature = 0; IMAGE_FILE_HEADER header{}; WORD magic = 0;
    const uint64_t offset = static_cast<uint64_t>(dos.e_lfanew);
    ReadAt(file, offset, &signature, sizeof(signature), size);
    ReadAt(file, offset + sizeof(signature), &header, sizeof(header), size);
    ReadAt(file, offset + sizeof(signature) + sizeof(header), &magic, sizeof(magic), size);
    if (signature != IMAGE_NT_SIGNATURE || header.Machine != IMAGE_FILE_MACHINE_AMD64
        || !(header.Characteristics & IMAGE_FILE_EXECUTABLE_IMAGE) || (header.Characteristics & IMAGE_FILE_DLL)
        || header.SizeOfOptionalHeader < sizeof(IMAGE_OPTIONAL_HEADER64) || magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC
        || header.NumberOfSections == 0 || header.NumberOfSections > 96)
        throw std::runtime_error("更新文件必须是 Windows x64 可执行程序");
    DWORD unused = 0;
    const DWORD bytes = GetFileVersionInfoSizeW(path.c_str(), &unused);
    if (!bytes || bytes > 1024 * 1024) throw std::runtime_error("更新文件缺少有效的版本信息");
    std::vector<unsigned char> resource(bytes);
    if (!GetFileVersionInfoW(path.c_str(), 0, bytes, resource.data())) throw std::runtime_error("无法读取更新文件版本");
    VS_FIXEDFILEINFO* fixed = nullptr; UINT fixedBytes = 0;
    if (!VerQueryValueW(resource.data(), L"\\", reinterpret_cast<void**>(&fixed), &fixedBytes) || !fixed
        || fixedBytes < sizeof(*fixed) || fixed->dwSignature != 0xfeef04bd || fixed->dwFileType != VFT_APP
        || HIWORD(fixed->dwFileVersionMS) != expected[0] || LOWORD(fixed->dwFileVersionMS) != expected[1]
        || HIWORD(fixed->dwFileVersionLS) != expected[2] || LOWORD(fixed->dwFileVersionLS) != 0)
        throw std::runtime_error("更新文件版本与发布版本不一致");
}
} // namespace VerifyDetail

inline std::string FileHash(const fs::path& path) {
    KernelHandle file(VerifyDetail::OpenLocked(path));
    return VerifyDetail::FileHash(file.value);
}

inline void VerifyExecutable(const fs::path& path, const std::string& sha256, const std::string& version,
                             const std::function<void()>& check = {}) {
    if (!ValidHash(sha256)) throw std::runtime_error("更新文件缺少有效的 SHA-256 校验值");
    KernelHandle file(VerifyDetail::OpenLocked(path));
    if (VerifyDetail::FileHash(file.value, check) != sha256) throw std::runtime_error("更新文件 SHA-256 校验不匹配，请重新下载");
    if (check) check();
    VerifyDetail::Executable(file.value, path, version);
}
} // namespace DesktopUpdate
