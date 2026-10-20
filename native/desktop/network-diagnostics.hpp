#pragma once
#include "platform.hpp"
#include <limits>

namespace DesktopNetworkDiagnostics {
struct Count { bool known = false; uint64_t value = 0; };

inline Count Counter(const Json& object, const char* key) {
    if (!object.is_object() || !object.contains(key)) return {};
    const auto& value = object[key];
    // The management response passes through JavaScript JSON parsing. Larger
    // numeric values may already be rounded before this native parser sees them.
    constexpr uint64_t maximumSafeInteger = 9007199254740991ULL;
    if (value.is_number_unsigned()) {
        const auto count = value.get<uint64_t>();
        return count <= maximumSafeInteger ? Count{true, count} : Count{};
    }
    if (value.is_number_integer() && value.get<int64_t>() >= 0) {
        const auto count = static_cast<uint64_t>(value.get<int64_t>());
        return count <= maximumSafeInteger ? Count{true, count} : Count{};
    }
    return {};
}

inline std::wstring Number(Count count, const wchar_t* unit) {
    if (!count.known) return L"—";
    auto text = std::to_wstring(count.value);
    for (size_t position = text.size(); position > 3; position -= 3) text.insert(position - 3, 1, L',');
    return text + L" " + unit;
}

inline std::wstring String(const Json& object, const char* key) {
    return object.is_object() && object.contains(key) && object[key].is_string() ? Wide(object[key].get<std::string>()) : L"";
}

inline std::wstring Path(const Json& row) {
    const auto path = String(row, "path");
    if (path == L"direct_ipv4") return L"直连 IPv4";
    if (path == L"direct_ipv6") return L"直连 IPv6";
    if (path == L"derp") return L"DERP 中继";
    if (path == L"peer_relay_ipv4") return L"节点中继 IPv4";
    if (path == L"peer_relay_ipv6") return L"节点中继 IPv6";
    return path.empty() ? L"未知路径" : L"其他路径（" + path + L"）";
}

inline Count Total(const Json& transport, const wchar_t* direction, const char* field) {
    if (!transport.is_array()) return {};
    Count total;
    const std::wstring paths[] = {L"direct_ipv4", L"direct_ipv6", L"derp", L"peer_relay_ipv4", L"peer_relay_ipv6"};
    bool seen[5]{};
    for (const auto& row : transport) {
        const auto rowDirection = String(row, "direction");
        if (rowDirection != L"inbound" && rowDirection != L"outbound") return {};
        if (rowDirection != direction) continue;
        const auto path = String(row, "path");
        size_t index = 0;
        while (index < 5 && paths[index] != path) ++index;
        if (index == 5 || seen[index]) return {};
        seen[index] = true;
        const auto count = Counter(row, field);
        if (!count.known || count.value > std::numeric_limits<uint64_t>::max() - total.value) return {};
        total.known = true; total.value += count.value;
    }
    for (bool present : seen) if (!present) return {};
    return total;
}

inline std::wstring Format(const Json& diagnostics) {
    const bool available = diagnostics.is_object() && diagnostics.contains("available") && diagnostics["available"].is_boolean() && diagnostics["available"].get<bool>();
    auto capturedAt = String(diagnostics, "capturedAt");
    if (capturedAt.size() > 19 && capturedAt[10] == L'T' && capturedAt.back() == L'Z') {
        capturedAt[10] = L' '; capturedAt.pop_back(); capturedAt += L" UTC";
    }
    std::wstring output = L"本机节点启动以来累计，包含模型和代理；重传不等于公网丢包率。\r\n"
        L"窗口打开期间每 2 秒自动刷新，也可点击“刷新”立即采样。\r\n\r\n";
    output += L"采样时间：" + (capturedAt.empty() ? L"—" : capturedAt) + L"\r\n";
    output += available ? L"数据状态：可用（本机内置节点）\r\n" : L"数据状态：不可用\r\n";
    const auto message = String(diagnostics, "message");
    if (!message.empty()) output += message + L"\r\n";
    const auto netstack = available && diagnostics.contains("netstack") && diagnostics["netstack"].is_object() ? diagnostics["netstack"] : Json();
    output += L"\r\nTCP 统计\r\n";
    struct Metric { const char* key; const wchar_t* label; const wchar_t* unit; };
    for (const auto& metric : {
        Metric{"counter_tcp_retransmits", L"TCP 重传", L"次"},
        Metric{"counter_tcp_fast_retransmit", L"快速重传", L"次"},
        Metric{"counter_tcp_timeouts", L"TCP 重传超时", L"次"},
        Metric{"counter_tcp_established_timeout", L"已建立连接超时", L"次"},
        Metric{"counter_tcp_segments_sent", L"TCP 发送报文段", L"段"},
        Metric{"counter_tcp_valid_segments_received", L"TCP 接收有效报文段", L"段"}
    }) output += std::wstring(metric.label) + L"：" + Number(Counter(netstack, metric.key), metric.unit) + L"\r\n";
    const auto transport = available && diagnostics.contains("transport") && diagnostics["transport"].is_array() ? diagnostics["transport"] : Json();
    output += L"\r\n节点传输总量\r\n发送：" + Number(Total(transport, L"outbound", "bytes"), L"字节") + L" / " + Number(Total(transport, L"outbound", "packets"), L"包");
    output += L"\r\n接收：" + Number(Total(transport, L"inbound", "bytes"), L"字节") + L" / " + Number(Total(transport, L"inbound", "packets"), L"包");
    output += L"\r\n\r\n各路径收发统计\r\n";
    if (!transport.is_array() || transport.empty()) output += L"路径统计：—\r\n";
    else for (const auto& row : transport) {
        const auto direction = String(row, "direction");
        const auto label = direction == L"inbound" ? L"接收" : direction == L"outbound" ? L"发送" : L"方向未知";
        output += Path(row) + L" · " + label + L"：" + Number(Counter(row, "bytes"), L"字节") + L" / " + Number(Counter(row, "packets"), L"包") + L"\r\n";
    }
    return output;
}
}
