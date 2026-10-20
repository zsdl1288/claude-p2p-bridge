#pragma once
#include "platform.hpp"

namespace DesktopCli {
struct Options {
    int port = 3210;
    fs::path directory;
    bool minimized = false, demo = false, system = false, version = false;
};

inline int Port(const std::wstring& value, bool allowZero = false) {
    if (value.empty() || value.find_first_not_of(L"0123456789") != std::wstring::npos)
        throw std::runtime_error("端口必须为 1–65535 的整数");
    // Bound while parsing, including arbitrarily long inputs, without throwing
    // implementation-specific stoi errors into the Chinese desktop interface.
    unsigned int port = 0;
    for (wchar_t digit : value) {
        port = port * 10 + static_cast<unsigned int>(digit - L'0');
        if (port > 65535) throw std::runtime_error("端口必须为 1–65535 的整数");
    }
    if (!port && !allowZero) throw std::runtime_error("端口必须为 1–65535 的整数");
    return static_cast<int>(port);
}

inline Options Parse(const std::vector<std::wstring>& arguments, const fs::path& defaultDirectory) {
    Options options; options.directory = defaultDirectory;
    for (size_t i = 0; i < arguments.size(); ++i) {
        const auto& argument = arguments[i];
        if ((argument == L"--port" || argument == L"--data-dir") && i + 1 == arguments.size())
            throw std::runtime_error("启动参数缺少值");
        if (argument == L"--port") options.port = Port(arguments[++i]);
        else if (argument == L"--data-dir") {
            const auto& directory = arguments[++i];
            if (directory.find_first_not_of(L" \t\r\n\v\f") == std::wstring::npos)
                throw std::runtime_error("数据目录不能为空");
            options.directory = fs::absolute(directory).lexically_normal();
        } else if (argument == L"--minimized" || argument == L"--no-browser") options.minimized = true;
        else if (argument == L"--demo") options.demo = true;
        else if (argument == L"--system-tailscale") options.system = true;
        else if (argument == L"--version") options.version = true;
        else throw std::runtime_error("不支持的启动参数: " + Utf8(argument));
    }
    return options;
}
}
