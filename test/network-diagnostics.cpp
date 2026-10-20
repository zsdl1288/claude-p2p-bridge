#include "../native/desktop/network-diagnostics.hpp"
#include <iostream>

void Require(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }

int main() {
    try {
        using namespace DesktopNetworkDiagnostics;
        Json sample = {{"available", true}, {"capturedAt", "2026-10-21T01:02:03.000Z"},
            {"netstack", {{"counter_tcp_retransmits", 0}, {"counter_tcp_fast_retransmit", 12345}, {"counter_tcp_timeouts", 3},
                {"counter_tcp_established_timeout", 4}, {"counter_tcp_segments_sent", 5}, {"counter_tcp_valid_segments_received", 6}}},
            {"transport", Json::array({
                {{"direction", "outbound"}, {"path", "direct_ipv4"}, {"bytes", 1024}, {"packets", 8}},
                {{"direction", "outbound"}, {"path", "derp"}, {"bytes", 2048}, {"packets", 10}},
                {{"direction", "inbound"}, {"path", "peer_relay_ipv6"}, {"bytes", 4096}, {"packets", 12}},
                {{"direction", "outbound"}, {"path", "direct_ipv6"}, {"bytes", 0}, {"packets", 0}},
                {{"direction", "outbound"}, {"path", "peer_relay_ipv4"}, {"bytes", 0}, {"packets", 0}},
                {{"direction", "outbound"}, {"path", "peer_relay_ipv6"}, {"bytes", 0}, {"packets", 0}},
                {{"direction", "inbound"}, {"path", "direct_ipv4"}, {"bytes", 0}, {"packets", 0}},
                {{"direction", "inbound"}, {"path", "direct_ipv6"}, {"bytes", 0}, {"packets", 0}},
                {{"direction", "inbound"}, {"path", "derp"}, {"bytes", 0}, {"packets", 0}},
                {{"direction", "inbound"}, {"path", "peer_relay_ipv4"}, {"bytes", 0}, {"packets", 0}}
            })}};
        auto text = Format(sample);
        Require(text.find(L"TCP 重传：0 次") != std::wstring::npos && text.find(L"快速重传：12,345 次") != std::wstring::npos, "Valid zero and grouped counters must be preserved");
        Require(text.find(L"2026-10-21 01:02:03.000 UTC") != std::wstring::npos, "Sample time must keep its timezone");
        Require(text.find(L"发送：3,072 字节 / 18 包") != std::wstring::npos && text.find(L"接收：4,096 字节 / 12 包") != std::wstring::npos, "Direction totals are incorrect");
        Require(text.find(L"直连 IPv4 · 发送") != std::wstring::npos && text.find(L"DERP 中继 · 发送") != std::wstring::npos && text.find(L"节点中继 IPv6 · 接收") != std::wstring::npos, "Transport labels must be Chinese");
        Require(text.find(L"本机节点启动以来累计，包含模型和代理；重传不等于公网丢包率") != std::wstring::npos, "The scope and retransmission explanation must be visible");
        Require(text.find(L"每 2 秒自动刷新") != std::wstring::npos, "The automatic refresh interval must be visible");
        constexpr uint64_t maximumSafeInteger = 9007199254740991ULL;
        Require(Counter({{"count", maximumSafeInteger}}, "count").known && Counter({{"count", maximumSafeInteger}}, "count").value == maximumSafeInteger, "The JavaScript safe integer boundary must be preserved");
        for (const auto& value : {Json(maximumSafeInteger + 1), Json(std::numeric_limits<uint64_t>::max()), Json(std::numeric_limits<int64_t>::max())})
            Require(!Counter({{"count", value}}, "count").known, "Numeric counters beyond the JavaScript safe integer range must be unknown");
        sample["available"] = false;
        text = Format(sample);
        Require(text.find(L"数据状态：不可用") != std::wstring::npos && text.find(L"TCP 重传：—") != std::wstring::npos && text.find(L"发送：— / —") != std::wstring::npos, "Unavailable data must never expose stale or invented zero counters");
        sample["available"] = true;
        sample["netstack"]["counter_tcp_retransmits"] = -1;
        sample["netstack"]["counter_tcp_fast_retransmit"] = maximumSafeInteger + 1;
        sample["netstack"].erase("counter_tcp_timeouts");
        sample["transport"][0].erase("bytes");
        text = Format(sample);
        Require(text.find(L"TCP 重传：—") != std::wstring::npos && text.find(L"快速重传：—") != std::wstring::npos && text.find(L"TCP 重传超时：—") != std::wstring::npos, "Invalid and missing values must remain unknown");
        Require(text.find(L"发送：— / 18 包") != std::wstring::npos, "One missing byte counter must invalidate the byte total without corrupting the packet total");
        sample["transport"][0]["bytes"] = std::numeric_limits<uint64_t>::max();
        Require(Format(sample).find(L"发送：— / 18 包") != std::wstring::npos, "An unsafe numeric counter must invalidate the total");
        sample["transport"].erase(sample["transport"].begin());
        Require(Format(sample).find(L"发送：— / —") != std::wstring::npos, "A missing path must not advertise a partial sum as the node total");
        sample["transport"] = Json::array();
        Require(Format(sample).find(L"发送：— / —") != std::wstring::npos, "An absent direction must not be assumed to have zero traffic");
        Require(Number({true, std::numeric_limits<uint64_t>::max()}, L"字节") == L"18,446,744,073,709,551,615 字节", "Full uint64 precision must be retained");
        Require(Format(Json()).find(L"采样时间：—") != std::wstring::npos, "Malformed snapshots must be reported as unavailable");
        std::cout << "Network diagnostics formatter passed\n";
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
