#pragma once
#include <filesystem>
#include <string>

namespace DesktopModelApi {
inline constexpr wchar_t DefaultModel[] = L"claude-code";

inline std::wstring BaseUrl(int port) {
    return L"http://127.0.0.1:" + std::to_wstring(port) + L"/v1";
}

inline std::wstring PowerShellExample(const std::filesystem::path& directory, int port) {
    auto tokenPath = (directory / L"api-token").wstring();
    for (size_t position = 0; (position = tokenPath.find(L'\'', position)) != std::wstring::npos; position += 2)
        tokenPath.insert(position, 1, L'\'');
    return L"$bridgeToken = (Get-Content -LiteralPath '" + tokenPath + L"' -Raw).Trim()\r\n"
        L"$bridgeHeaders = @{ Authorization = \"Bearer $bridgeToken\" }\r\n"
        L"$bridgeBody = @{ model = 'claude-code'; messages = @(@{ role = 'user'; content = '请用一句话说明你能提供什么帮助' }); stream = $false } | ConvertTo-Json -Depth 8\r\n"
        L"$bridgeReply = Invoke-RestMethod -Uri '" + BaseUrl(port) + L"/chat/completions' -Method Post -Headers $bridgeHeaders -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($bridgeBody)) -TimeoutSec 3660\r\n"
        L"$bridgeReply.choices[0].message | ConvertTo-Json -Depth 16\r\n";
}
}
