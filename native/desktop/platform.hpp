#pragma once
#ifndef UNICODE
#define UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <windowsx.h>
#include <winhttp.h>
#include <shellapi.h>
#include <shlobj.h>
#include <bcrypt.h>
#include <commctrl.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <memory>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <vector>
#include "vendor/json.hpp"

using Json = nlohmann::json;
namespace fs = std::filesystem;

inline std::wstring Wide(const std::string& text) {
    if (text.empty()) return {};
    int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0);
    if (!count) return L"无效的 UTF-8 文本";
    std::wstring result(count, L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), result.data(), count);
    return result;
}
inline std::string Utf8(const std::wstring& text) {
    if (text.empty()) return {};
    int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
    if (!count) throw std::runtime_error("文本编码无效");
    std::string result(count, '\0');
    WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), result.data(), count, nullptr, nullptr);
    return result;
}
inline std::string WindowsError(const char* operation) {
    return std::string(operation) + " (Windows " + std::to_string(GetLastError()) + ")";
}
struct KernelHandle {
    HANDLE value = nullptr;
    ~KernelHandle() { reset(); }
    KernelHandle() = default;
    explicit KernelHandle(HANDLE h) : value(h) {}
    KernelHandle(const KernelHandle&) = delete;
    KernelHandle& operator=(const KernelHandle&) = delete;
    void reset(HANDLE h = nullptr) { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); value = h; }
};
struct HttpHandle {
    HINTERNET value = nullptr;
    ~HttpHandle() { if (value) WinHttpCloseHandle(value); }
    HttpHandle() = default;
    explicit HttpHandle(HINTERNET h) : value(h) {}
    HttpHandle(const HttpHandle&) = delete;
    HttpHandle& operator=(const HttpHandle&) = delete;
};

inline std::string ApiErrorMessage(const Json& data) {
    if (data.is_object() && data.contains("error")) {
        const auto& error = data["error"];
        if (error.is_string()) return error.get<std::string>();
        if (error.is_object() && error.contains("message") && error["message"].is_string())
            return error["message"].get<std::string>();
    }
    return "本机 API 调用失败";
}

// Every connection is explicitly local and bypasses system HTTP proxy settings.
class LocalRequest {
    HttpHandle session_, connection_;
public:
    HttpHandle request;
    DWORD status = 0;
    LocalRequest(int port, const std::string& token, const std::wstring& route,
                 const Json* body = nullptr, int timeout = 3000, bool bootstrap = false)
        : session_(WinHttpOpen(L"ClaudeBridge-Native", WINHTTP_ACCESS_TYPE_NO_PROXY,
                              WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0)) {
        if (!session_.value) throw std::runtime_error(WindowsError("WinHttpOpen"));
        if (!WinHttpSetTimeouts(session_.value, 1500, 1500, 5000, timeout))
            throw std::runtime_error(WindowsError("配置本机请求超时"));
        connection_.value = WinHttpConnect(session_.value, L"127.0.0.1", static_cast<INTERNET_PORT>(port), 0);
        if (!connection_.value) throw std::runtime_error(WindowsError("WinHttpConnect"));
        request.value = WinHttpOpenRequest(connection_.value, body ? L"POST" : L"GET", route.c_str(),
                                           nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0);
        if (!request.value) throw std::runtime_error(WindowsError("WinHttpOpenRequest"));
        DWORD redirect = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
        if (!WinHttpSetOption(request.value, WINHTTP_OPTION_REDIRECT_POLICY, &redirect, sizeof(redirect)))
            throw std::runtime_error(WindowsError("禁用本机请求重定向"));
        std::wstring headers = L"Content-Type: application/json; charset=utf-8\r\n";
        if (!token.empty()) headers += L"Authorization: Bearer " + Wide(token) + L"\r\n";
        if (bootstrap) headers += L"X-Bridge-UI: 1\r\n";
        std::string content = body ? body->dump() : "";
        if (!WinHttpSendRequest(request.value, headers.c_str(), static_cast<DWORD>(headers.size()),
                                content.empty() ? WINHTTP_NO_REQUEST_DATA : content.data(),
                                static_cast<DWORD>(content.size()), static_cast<DWORD>(content.size()), 0)
            || !WinHttpReceiveResponse(request.value, nullptr))
            throw std::runtime_error(WindowsError("本机服务未响应"));
        DWORD size = sizeof(status);
        if (!WinHttpQueryHeaders(request.value, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                                 WINHTTP_HEADER_NAME_BY_INDEX, &status, &size, WINHTTP_NO_HEADER_INDEX))
            throw std::runtime_error(WindowsError("读取 HTTP 状态"));
    }
    std::string ReadAll() {
        std::string result;
        char buffer[16384]; DWORD count;
        for (;;) {
            if (!WinHttpReadData(request.value, buffer, sizeof(buffer), &count))
                throw std::runtime_error(WindowsError("读取本机响应"));
            if (!count) break;
            result.append(buffer, count);
            if (result.size() > 12 * 1024 * 1024) throw std::runtime_error("本机响应过大");
        }
        return result;
    }
    DWORD ReadAvailable(char* buffer, DWORD capacity) {
        if (!capacity) throw std::runtime_error("读取缓冲区不能为空");
        DWORD available = 0, count = 0;
        if (!WinHttpQueryDataAvailable(request.value, &available))
            throw std::runtime_error(WindowsError("等待任务输出"));
        // An ordinary WinHttpReadData call tries to fill its buffer. Read only
        // the bytes available now so small SSE events reach the UI immediately.
        // A final one-byte read confirms EOF using ReadData's return count.
        DWORD size = std::min(capacity, available ? available : DWORD{1});
        if (!WinHttpReadData(request.value, buffer, size, &count))
            throw std::runtime_error(WindowsError("读取任务输出"));
        return count;
    }
    Json ReadJson() {
        auto data = Json::parse(ReadAll());
        if (status < 200 || status >= 300) throw std::runtime_error(ApiErrorMessage(data));
        return data;
    }
    std::string RequestId() {
        wchar_t buffer[128]; DWORD bytes = sizeof(buffer);
        if (!WinHttpQueryHeaders(request.value, WINHTTP_QUERY_CUSTOM, L"X-Request-ID", buffer, &bytes, WINHTTP_NO_HEADER_INDEX)) return {};
        return Utf8(buffer);
    }
};

inline Json Api(int port, const std::string& token, const std::wstring& route, const Json* body = nullptr, int timeout = 3000) {
    LocalRequest request(port, token, route, body, timeout, route == L"/api/bootstrap");
    return request.ReadJson();
}

inline bool LocalHttpListening(int port, int timeout = 700) {
    try {
        // Any HTTP response occupies the port, including another program's
        // error page. Do not wait for an unrelated response body to finish.
        LocalRequest probe(port, "", L"/health", nullptr, timeout);
        return true;
    } catch (...) { return false; }
}

// Decode complete JSON SSE data events without splitting UTF-8 characters.
// HTTP chunk boundaries are unrelated to event boundaries; comments are ignored.
class SseDecoder {
    std::string buffer_;
    static constexpr size_t MAX_FRAME = 4 * 1024 * 1024;
public:
    std::vector<Json> Feed(std::string_view chunk) {
        buffer_.append(chunk);
        std::vector<Json> events;
        for (;;) {
            auto lf = buffer_.find("\n\n"), crlf = buffer_.find("\r\n\r\n");
            auto boundary = std::min(lf, crlf);
            if (boundary == std::string::npos) break;
            if (boundary > MAX_FRAME) throw std::runtime_error("任务事件过大");
            size_t delimiter = boundary == crlf ? 4 : 2;
            std::string data;
            size_t start = 0;
            while (start < boundary) {
                auto end = buffer_.find('\n', start);
                if (end == std::string::npos || end > boundary) end = boundary;
                auto length = end - start;
                if (length && buffer_[start + length - 1] == '\r') --length;
                std::string_view line(buffer_.data() + start, length);
                if (line.starts_with("data:")) {
                    line.remove_prefix(5);
                    if (line.starts_with(' ')) line.remove_prefix(1);
                    if (!data.empty()) data += '\n';
                    data.append(line);
                }
                start = end + 1;
            }
            buffer_.erase(0, boundary + delimiter);
            if (data == "[DONE]") events.push_back(Json{{"type", "sse-done"}});
            else if (!data.empty()) events.push_back(Json::parse(data));
        }
        if (buffer_.size() > MAX_FRAME) throw std::runtime_error("任务事件过大");
        return events;
    }
};

inline std::wstring QuoteArgument(const std::wstring& value) {
    std::wstring result = L"\""; size_t slashes = 0;
    for (wchar_t ch : value) {
        if (ch == L'\\') { ++slashes; continue; }
        if (ch == L'\"') result.append(slashes * 2 + 1, L'\\');
        else result.append(slashes, L'\\');
        slashes = 0; result += ch;
    }
    result.append(slashes * 2, L'\\');
    return result + L"\"";
}

inline std::string Sha256(const unsigned char* data, size_t size) {
    BCRYPT_ALG_HANDLE algorithm = nullptr; BCRYPT_HASH_HANDLE hash = nullptr;
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0)
        throw std::runtime_error("无法初始化资源校验");
    DWORD objectSize = 0, received = 0;
    if (BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&objectSize), sizeof(objectSize), &received, 0) < 0
        || received != sizeof(objectSize) || !objectSize) {
        BCryptCloseAlgorithmProvider(algorithm, 0);
        throw std::runtime_error("无法读取资源校验参数");
    }
    std::vector<unsigned char> object(objectSize); unsigned char digest[32];
    auto result = BCryptCreateHash(algorithm, &hash, object.data(), objectSize, nullptr, 0, 0);
    if (result >= 0) result = BCryptHashData(hash, const_cast<PUCHAR>(data), static_cast<ULONG>(size), 0);
    if (result >= 0) result = BCryptFinishHash(hash, digest, sizeof(digest), 0);
    if (hash) BCryptDestroyHash(hash);
    BCryptCloseAlgorithmProvider(algorithm, 0);
    if (result < 0) throw std::runtime_error("资源校验失败");
    std::ostringstream out; out << std::hex << std::setfill('0');
    for (auto byte : digest) out << std::setw(2) << static_cast<unsigned>(byte);
    return out.str();
}

inline bool SafeLoginUrl(const std::string& text) {
    auto value = Wide(text); URL_COMPONENTS parts{}; parts.dwStructSize = sizeof(parts);
    parts.dwHostNameLength = parts.dwUserNameLength = parts.dwPasswordLength = static_cast<DWORD>(-1);
    if (!WinHttpCrackUrl(value.c_str(), static_cast<DWORD>(value.size()), 0, &parts)) return false;
    return parts.nScheme == INTERNET_SCHEME_HTTPS && parts.nPort == 443
        && std::wstring(parts.lpszHostName, parts.dwHostNameLength) == L"login.tailscale.com"
        && parts.dwUserNameLength == 0 && parts.dwPasswordLength == 0;
}

inline void OpenLink(HWND owner, const std::wstring& url) {
    ShellExecuteW(owner, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}

inline std::wstring ControlText(HWND control) {
    int length = GetWindowTextLengthW(control);
    std::wstring result(length + 1, L'\0');
    GetWindowTextW(control, result.data(), length + 1); result.resize(length);
    return result;
}
inline void Clipboard(HWND owner, const std::wstring& text) {
    if (!OpenClipboard(owner)) throw std::runtime_error("剪贴板正被占用，请稍后重试");
    HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE, (text.size() + 1) * sizeof(wchar_t));
    if (!memory) { CloseClipboard(); throw std::runtime_error("无法分配剪贴板内存"); }
    void* target = GlobalLock(memory);
    if (!target) { GlobalFree(memory); CloseClipboard(); throw std::runtime_error("无法访问剪贴板"); }
    memcpy(target, text.c_str(), (text.size() + 1) * sizeof(wchar_t)); GlobalUnlock(memory);
    EmptyClipboard();
    if (!SetClipboardData(CF_UNICODETEXT, memory)) { GlobalFree(memory); CloseClipboard(); throw std::runtime_error("复制失败"); }
    CloseClipboard();
}
