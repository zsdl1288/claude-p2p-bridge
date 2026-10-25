#pragma once
#include "update-verify.hpp"

#ifndef BRIDGE_UPDATE_REPOSITORY
#define BRIDGE_UPDATE_REPOSITORY "zsdl1288/claude-p2p-bridge"
#endif

namespace DesktopUpdate {
inline constexpr const char* Repository = BRIDGE_UPDATE_REPOSITORY;
inline constexpr bool ValidRepository(std::string_view value) {
    const auto separator = value.find('/');
    if (value.size() > 200 || separator == 0 || separator == std::string_view::npos || separator + 1 == value.size()
        || value.find('/', separator + 1) != std::string_view::npos
        || value.substr(0, separator) == "." || value.substr(0, separator) == ".."
        || value.substr(separator + 1) == "." || value.substr(separator + 1) == "..") return false;
    for (const auto c : value) if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                                    || c == '-' || c == '_' || c == '.' || c == '/')) return false;
    return true;
}
static_assert(ValidRepository(Repository), "BRIDGE_UPDATE_REPOSITORY must be a fixed GitHub owner/repository");
inline const std::string LatestReleaseUrl = std::string("https://api.github.com/repos/") + Repository + "/releases/latest";
inline constexpr size_t MaximumApiBytes = 2 * 1024 * 1024;
inline constexpr size_t MaximumChecksumBytes = 4096;

namespace ReleaseDetail {
inline std::string String(const Json& value, const char* key) {
    return value.is_object() && value.contains(key) && value[key].is_string() ? value[key].get<std::string>() : "";
}
inline uint64_t PositiveSize(const Json& value, uint64_t maximum) {
    if (!value.is_number_integer() || (value.is_number_integer() && !value.is_number_unsigned() && value.get<int64_t>() <= 0))
        throw std::runtime_error("发布文件大小无效");
    const auto size = value.get<uint64_t>();
    if (!size || size > maximum) throw std::runtime_error("发布文件大小超出允许范围");
    return size;
}
inline std::string AssetName(const std::string& version) { return "ClaudeBridge-" + version + "-windows-x64.exe"; }
inline std::string AssetUrl(const std::string& tag, const std::string& name) {
    return std::string("https://github.com/") + Repository + "/releases/download/" + tag + "/" + name;
}
inline std::string HtmlUrl(const std::string& tag) { return std::string("https://github.com/") + Repository + "/releases/tag/" + tag; }
inline std::string Digest(const Json& asset) {
    if (!asset.contains("digest") || asset["digest"].is_null() || asset["digest"] == "") return "";
    auto digest = String(asset, "digest");
    if (digest.size() != 71 || digest.substr(0, 7) != "sha256:") throw std::runtime_error("发布文件 SHA-256 摘要无效");
    auto hash = digest.substr(7);
    for (auto& c : hash) if (c >= 'A' && c <= 'F') c = static_cast<char>(c - 'A' + 'a');
    if (!ValidHash(hash)) throw std::runtime_error("发布文件 SHA-256 摘要无效");
    return hash;
}
inline const Json* FindAsset(const Json& release, const std::string& name) {
    if (!release.contains("assets") || !release["assets"].is_array() || release["assets"].size() > 1000)
        throw std::runtime_error("GitHub 发布文件列表无效");
    const Json* found = nullptr;
    for (const auto& asset : release["assets"]) if (String(asset, "name") == name) {
        if (found) throw std::runtime_error("发布中存在重复的更新文件");
        found = &asset;
    }
    return found;
}
inline void ValidateAsset(const Json& asset, const std::string& tag, const std::string& name, uint64_t maximum) {
    if (String(asset, "state") != "uploaded" || String(asset, "browser_download_url") != AssetUrl(tag, name))
        throw std::runtime_error("发布文件地址不属于指定仓库或文件尚未上传完成");
    PositiveSize(asset.value("size", Json()), maximum);
}
inline void ValidateRelease(const Json& value) {
    const auto version = String(value, "version"), tag = String(value, "tag");
    std::array<unsigned, 3> parts{};
    if (!ParseVersion(version, parts) || (tag != version && tag != "v" + version)
        || String(value, "name") != AssetName(version) || String(value, "url") != AssetUrl(tag, AssetName(version))
        || String(value, "htmlUrl") != HtmlUrl(tag) || !ValidHash(String(value, "sha256")))
        throw std::runtime_error("更新信息无效，请重新检查更新");
    PositiveSize(value.value("size", Json()), MaximumExecutableBytes);
}

struct Url { std::wstring host, route; };
inline Url ParseUrl(const std::string& text, bool api = false) {
    if (text.empty() || text.size() > 8192 || std::any_of(text.begin(), text.end(), [](unsigned char c) {
        return c <= 32 || c >= 127 || c == '\\' || c == '#';
    })) throw std::runtime_error("更新下载地址无效");
    const auto authorityStart = text.find("://"), authorityEnd = authorityStart == std::string::npos ? std::string::npos : text.find('/', authorityStart + 3);
    if (authorityStart == std::string::npos || text.substr(authorityStart + 3, authorityEnd - (authorityStart + 3)).find('@') != std::string::npos)
        throw std::runtime_error("更新下载地址不能包含登录凭据");
    const auto wide = Wide(text); URL_COMPONENTS parts{}; parts.dwStructSize = sizeof(parts);
    parts.dwHostNameLength = parts.dwUrlPathLength = parts.dwExtraInfoLength = parts.dwUserNameLength = parts.dwPasswordLength = static_cast<DWORD>(-1);
    if (!WinHttpCrackUrl(wide.c_str(), static_cast<DWORD>(wide.size()), 0, &parts)
        || parts.nScheme != INTERNET_SCHEME_HTTPS || parts.nPort != 443 || parts.dwUserNameLength || parts.dwPasswordLength)
        throw std::runtime_error("更新只允许使用受信任的 HTTPS 地址");
    Url url{std::wstring(parts.lpszHostName, parts.dwHostNameLength), std::wstring(parts.lpszUrlPath, parts.dwUrlPathLength)};
    if (parts.dwExtraInfoLength) url.route.append(parts.lpszExtraInfo, parts.dwExtraInfoLength);
    if (api) {
        if (text != LatestReleaseUrl) throw std::runtime_error("更新 API 地址不属于指定仓库");
    } else {
        if (url.host != L"github.com" && url.host != L"release-assets.githubusercontent.com" && url.host != L"objects.githubusercontent.com")
            throw std::runtime_error("更新下载重定向到了不受信任的服务器");
        if (url.host == L"github.com" && url.route.rfind(Wide(std::string("/") + Repository + "/releases/download/"), 0) != 0)
            throw std::runtime_error("更新下载地址不属于指定仓库");
    }
    if (url.route.empty() || url.route.front() != L'/') throw std::runtime_error("更新下载地址无效");
    return url;
}

class Budget {
    const std::atomic<bool>& cancel_;
    std::chrono::steady_clock::time_point end_;
public:
    Budget(const std::atomic<bool>& cancel, std::chrono::seconds seconds) : cancel_(cancel), end_(std::chrono::steady_clock::now() + seconds) {}
    void Check() const {
        if (cancel_.load()) throw std::runtime_error("更新已取消");
        if (std::chrono::steady_clock::now() >= end_) throw std::runtime_error("更新请求超时，请稍后重试");
    }
    void Timeouts(HINTERNET request) const {
        Check();
        const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(end_ - std::chrono::steady_clock::now()).count();
        const int timeout = static_cast<int>(std::max<int64_t>(1, std::min<int64_t>(5000, remaining)));
        if (!WinHttpSetTimeouts(request, std::min(timeout, 3000), timeout, timeout, timeout)) throw std::runtime_error("无法配置更新网络超时");
    }
};
inline std::string Header(HINTERNET request, DWORD query) {
    DWORD bytes = 0;
    if (!WinHttpQueryHeaders(request, query, WINHTTP_HEADER_NAME_BY_INDEX, nullptr, &bytes, WINHTTP_NO_HEADER_INDEX)) {
        if (GetLastError() == ERROR_WINHTTP_HEADER_NOT_FOUND) return "";
        if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || bytes > 32768) throw std::runtime_error("更新服务器响应头无效");
    }
    std::vector<wchar_t> value(bytes / sizeof(wchar_t) + 1, L'\0');
    if (!WinHttpQueryHeaders(request, query, WINHTTP_HEADER_NAME_BY_INDEX, value.data(), &bytes, WINHTTP_NO_HEADER_INDEX))
        throw std::runtime_error("无法读取更新服务器响应头");
    return Utf8(std::wstring(value.data()));
}
inline uint64_t ContentLength(const std::string& value, uint64_t maximum) {
    if (value.empty()) return 0;
    uint64_t length = 0;
    for (const auto c : value) {
        if (c < '0' || c > '9' || length > maximum / 10) throw std::runtime_error("更新响应大小无效");
        length = length * 10 + static_cast<unsigned>(c - '0');
        if (length > maximum) throw std::runtime_error("更新响应超过大小限制");
    }
    return length;
}
using Sink = std::function<void(const char*, size_t)>;

// No authentication headers or cookies are sent. Automatic redirects and
// automatic integrated authentication are disabled on every request.
inline void Fetch(const std::string& initialUrl, bool api, uint64_t maximum, uint64_t expected,
                  Budget& budget, const Sink& sink) {
    HttpHandle session(WinHttpOpen(L"ClaudeBridge-Updater", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                                  WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0));
    if (!session.value) throw std::runtime_error("无法初始化更新网络连接");
    std::string next = initialUrl;
    for (unsigned redirects = 0; redirects <= 4; ++redirects) {
        budget.Check(); const auto url = ParseUrl(next, api);
        HttpHandle connection(WinHttpConnect(session.value, url.host.c_str(), INTERNET_DEFAULT_HTTPS_PORT, 0));
        if (!connection.value) throw std::runtime_error("无法连接 GitHub 更新服务器");
        HttpHandle request(WinHttpOpenRequest(connection.value, L"GET", url.route.c_str(), nullptr, WINHTTP_NO_REFERER,
                                              WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE));
        if (!request.value) throw std::runtime_error("无法建立更新请求");
        DWORD redirect = WINHTTP_OPTION_REDIRECT_POLICY_NEVER, disabled = WINHTTP_DISABLE_COOKIES | WINHTTP_DISABLE_AUTHENTICATION;
        DWORD autologon = WINHTTP_AUTOLOGON_SECURITY_LEVEL_HIGH;
        if (!WinHttpSetOption(request.value, WINHTTP_OPTION_REDIRECT_POLICY, &redirect, sizeof(redirect))
            || !WinHttpSetOption(request.value, WINHTTP_OPTION_DISABLE_FEATURE, &disabled, sizeof(disabled))
            || !WinHttpSetOption(request.value, WINHTTP_OPTION_AUTOLOGON_POLICY, &autologon, sizeof(autologon)))
            throw std::runtime_error("无法配置安全更新请求");
        const wchar_t* headers = api ? L"Accept: application/vnd.github+json\r\nX-GitHub-Api-Version: 2026-03-10\r\n" : L"Accept: application/octet-stream\r\n";
        budget.Timeouts(request.value);
        if (!WinHttpSendRequest(request.value, headers, static_cast<DWORD>(-1), WINHTTP_NO_REQUEST_DATA, 0, 0, 0)) {
            budget.Check(); throw std::runtime_error("无法访问 GitHub，请检查网络后重试");
        }
        budget.Timeouts(request.value);
        if (!WinHttpReceiveResponse(request.value, nullptr)) { budget.Check(); throw std::runtime_error("GitHub 更新服务器未响应，请稍后重试"); }
        budget.Check(); DWORD status = 0, bytes = sizeof(status);
        if (!WinHttpQueryHeaders(request.value, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX,
                                 &status, &bytes, WINHTTP_NO_HEADER_INDEX)) throw std::runtime_error("无法读取更新服务器状态");
        if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
            if (api || redirects == 4) throw std::runtime_error("更新服务器重定向次数过多或地址发生变化");
            next = Header(request.value, WINHTTP_QUERY_LOCATION); ParseUrl(next); continue;
        }
        if (status == 403 || status == 429) throw std::runtime_error("GitHub 暂时限制了更新请求，请稍后再试");
        if (status == 404) throw std::runtime_error("无法读取更新发布，请确认更新仓库和 Release 对客户端公开可访问");
        if (status != 200) throw std::runtime_error("GitHub 更新请求失败（HTTP " + std::to_string(status) + "）");
        const auto encoding = Header(request.value, WINHTTP_QUERY_CONTENT_ENCODING);
        if (!encoding.empty() && encoding != "identity") throw std::runtime_error("更新服务器返回了不支持的编码");
        const auto declared = ContentLength(Header(request.value, WINHTTP_QUERY_CONTENT_LENGTH), maximum);
        if (expected && declared && declared != expected) throw std::runtime_error("更新文件大小与发布信息不一致");
        std::array<char, 65536> buffer{}; uint64_t total = 0;
        for (;;) {
            budget.Timeouts(request.value); DWORD available = 0, count = 0;
            if (!WinHttpQueryDataAvailable(request.value, &available)) {
                budget.Check(); throw std::runtime_error("更新下载中断，请重新下载");
            }
            // Reading an entire 64 KiB buffer can wait for many small packets.
            // Read only currently available bytes so a slow stream cannot
            // indefinitely postpone cancellation or the absolute budget.
            budget.Timeouts(request.value);
            const auto capacity = std::min<DWORD>(static_cast<DWORD>(buffer.size()), available ? available : 1);
            if (!WinHttpReadData(request.value, buffer.data(), capacity, &count)) {
                budget.Check(); throw std::runtime_error("更新下载中断，请重新下载");
            }
            budget.Check(); if (!count) break;
            if (count > maximum - total || (expected && count > expected - total)) throw std::runtime_error("更新响应超过大小限制");
            total += count; sink(buffer.data(), count);
        }
        if ((expected && total != expected) || (declared && total != declared)) throw std::runtime_error("更新文件下载不完整");
        return;
    }
    throw std::runtime_error("更新服务器重定向次数过多");
}
inline std::string Read(const std::string& url, bool api, uint64_t maximum, uint64_t expected, Budget& budget) {
    std::string result;
    Fetch(url, api, maximum, expected, budget, [&](const char* bytes, size_t size) { result.append(bytes, size); });
    return result;
}
inline std::string ParseChecksum(std::string content, const std::string& name) {
    if (content.size() > MaximumChecksumBytes) throw std::runtime_error("SHA-256 校验文件过大");
    if (!content.empty() && content.back() == '\n') { content.pop_back(); if (!content.empty() && content.back() == '\r') content.pop_back(); }
    if (content.size() != 66 + name.size() || content[64] != ' ' || (content[65] != ' ' && content[65] != '*') || content.substr(66) != name)
        throw std::runtime_error("SHA-256 校验文件与更新文件不匹配");
    auto hash = content.substr(0, 64);
    for (auto& c : hash) if (c >= 'A' && c <= 'F') c = static_cast<char>(c - 'A' + 'a');
    if (!ValidHash(hash)) throw std::runtime_error("SHA-256 校验文件无效");
    return hash;
}

// The injected fetch is a private test seam; production still validates the
// fixed repository metadata before opening any destination or network URL.
template<class Fetcher>
inline fs::path Download(const Json& release, const fs::path& directory, const std::atomic<bool>& cancel,
                         const std::function<void(uint64_t, uint64_t)>& progress, Fetcher&& fetch) {
    ValidateRelease(release); Budget budget(cancel, std::chrono::minutes(15)); budget.Check();
    const auto expected = PositiveSize(release["size"], MaximumExecutableBytes);
    KernelHandle directoryLock(CreateFileW(directory.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
                                           nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    BY_HANDLE_FILE_INFORMATION info{};
    if (directoryLock.value == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(directoryLock.value, &info)
        || !(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT))
        throw std::runtime_error("更新暂存目录无效");
    const auto part = directory / L"new.exe.part", complete = directory / L"new.exe";
    if (GetFileAttributesW(complete.c_str()) != INVALID_FILE_ATTRIBUTES) throw std::runtime_error("更新暂存文件已存在，请重新开始更新");
    KernelHandle output(CreateFileW(part.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW,
                                    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN, nullptr));
    if (output.value == INVALID_HANDLE_VALUE) throw std::runtime_error("无法创建更新暂存文件");
    try {
        uint64_t total = 0; if (progress) progress(0, expected);
        fetch(String(release, "url"), expected, budget, [&](const char* bytes, size_t count) {
            budget.Check();
            if (count > expected - total || count > std::numeric_limits<DWORD>::max()) throw std::runtime_error("更新文件大小与发布信息不一致");
            DWORD written = 0;
            if (!WriteFile(output.value, bytes, static_cast<DWORD>(count), &written, nullptr) || written != count) throw std::runtime_error("无法写入更新文件，请检查磁盘空间");
            total += count; if (progress) progress(total, expected);
        });
        budget.Check();
        if (total != expected) throw std::runtime_error("更新文件下载不完整");
        if (!FlushFileBuffers(output.value)) throw std::runtime_error("无法保存更新文件");
        output.reset();
        VerifyExecutable(part, String(release, "sha256"), String(release, "version"), [&] { budget.Check(); });
        budget.Check();
        if (!MoveFileExW(part.c_str(), complete.c_str(), MOVEFILE_WRITE_THROUGH)) throw std::runtime_error("无法完成更新文件保存");
        return complete;
    } catch (...) { output.reset(); DeleteFileW(part.c_str()); throw; }
}
} // namespace ReleaseDetail

// Pure selection only. An empty sha256 means that CheckRelease must obtain the
// exact same release's checksum asset; DownloadRelease never accepts it.
inline Json ParseRelease(const Json& source, const std::string& currentVersion) {
    std::array<unsigned, 3> current{}, candidate{};
    if (!ParseVersion(currentVersion, current)) throw std::runtime_error("当前程序版本号无效");
    if (!source.is_object() || !source.contains("draft") || !source["draft"].is_boolean()
        || !source.contains("prerelease") || !source["prerelease"].is_boolean()) throw std::runtime_error("GitHub 发布信息格式无效");
    if (source["draft"].get<bool>() || source["prerelease"].get<bool>()) return nullptr;
    const auto tag = ReleaseDetail::String(source, "tag_name");
    const auto version = !tag.empty() && tag.front() == 'v' ? tag.substr(1) : tag;
    if (!ParseVersion(version, candidate) || candidate <= current) return nullptr;
    const auto name = ReleaseDetail::AssetName(version);
    if (ReleaseDetail::String(source, "html_url") != ReleaseDetail::HtmlUrl(tag)) throw std::runtime_error("更新发布地址不属于指定仓库");
    const auto* asset = ReleaseDetail::FindAsset(source, name);
    if (!asset) throw std::runtime_error("最新发布缺少正式 Windows x64 更新文件");
    ReleaseDetail::ValidateAsset(*asset, tag, name, MaximumExecutableBytes);
    return Json{{"version", version}, {"tag", tag}, {"name", name}, {"url", ReleaseDetail::AssetUrl(tag, name)},
                {"size", ReleaseDetail::PositiveSize((*asset)["size"], MaximumExecutableBytes)},
                {"sha256", ReleaseDetail::Digest(*asset)}, {"htmlUrl", ReleaseDetail::HtmlUrl(tag)}};
}

namespace ReleaseDetail {
template<class Reader>
inline Json Check(const std::string& currentVersion, const std::atomic<bool>& cancel, Reader&& read) {
    ReleaseDetail::Budget budget(cancel, std::chrono::seconds(30));
    budget.Check();
    const auto body = read(LatestReleaseUrl, true, MaximumApiBytes, 0, budget);
    Json source;
    try { source = Json::parse(body); } catch (...) { throw std::runtime_error("GitHub 发布信息不是有效的 JSON"); }
    auto release = ParseRelease(source, currentVersion);
    if (release.is_null()) return nullptr;
    if (release["sha256"] == "") {
        const auto version = release["version"].get<std::string>(), tag = release["tag"].get<std::string>();
        const auto name = std::string("ClaudeBridge-") + version + "-windows-x64.sha256.txt";
        const auto* asset = ReleaseDetail::FindAsset(source, name);
        if (!asset) throw std::runtime_error("该发布缺少 SHA-256 校验，无法安全更新");
        ReleaseDetail::ValidateAsset(*asset, tag, name, MaximumChecksumBytes);
        const auto checksum = read(ReleaseDetail::AssetUrl(tag, name), false, MaximumChecksumBytes,
                                   ReleaseDetail::PositiveSize((*asset)["size"], MaximumChecksumBytes), budget);
        const auto checksumDigest = ReleaseDetail::Digest(*asset);
        if (!checksumDigest.empty() && Sha256(reinterpret_cast<const unsigned char*>(checksum.data()), checksum.size()) != checksumDigest)
            throw std::runtime_error("SHA-256 校验文件自身校验失败");
        release["sha256"] = ReleaseDetail::ParseChecksum(checksum, release["name"].get<std::string>());
    }
    budget.Check(); ReleaseDetail::ValidateRelease(release); return release;
}
} // namespace ReleaseDetail

inline Json CheckRelease(const std::string& currentVersion, const std::atomic<bool>& cancel) {
    return ReleaseDetail::Check(currentVersion, cancel, ReleaseDetail::Read);
}

inline fs::path DownloadRelease(const Json& release, const fs::path& stagingDirectory, const std::atomic<bool>& cancel,
                                const std::function<void(uint64_t, uint64_t)>& progress) {
    return ReleaseDetail::Download(release, stagingDirectory, cancel, progress,
        [](const std::string& url, uint64_t size, ReleaseDetail::Budget& budget, const ReleaseDetail::Sink& sink) {
            ReleaseDetail::Fetch(url, false, MaximumExecutableBytes, size, budget, sink);
        });
}
} // namespace DesktopUpdate
