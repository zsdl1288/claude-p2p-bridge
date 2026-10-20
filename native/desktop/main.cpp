#include "platform.hpp"
#include "ids.hpp"
#include "build_config.hpp"
#include "startup.hpp"
#include "profile-lock.hpp"
#include "model-api.hpp"
#include "options.hpp"
#include "role-ui.hpp"
#include "single-instance.hpp"
#include "job-lifecycle.hpp"
#include <uxtheme.h>

namespace {
constexpr COLORREF BACKGROUND = RGB(245, 246, 249), SIDEBAR = RGB(23, 30, 42);
constexpr COLORREF INK = RGB(31, 42, 58), MUTED = RGB(104, 116, 134), ACCENT = RGB(178, 82, 57);
constexpr COLORREF LINE = RGB(225, 229, 235), GREEN = RGB(28, 119, 93);
constexpr wchar_t APP_TITLE[] = L"Claude Bridge · C++ 桌面版";
using Options = DesktopCli::Options;
struct Reply { std::string kind; Json data; std::string text, requestId; uint64_t viewEpoch = 0; };
struct Widget {
    HWND window; int page, role, x, y, w, h, font; bool right = false, stretch = false, taller = false;
    bool sidebar = false, muted = false, edit = false;
};

class Application {
    Options options_; HINSTANCE instance_; HWND window_ = nullptr;
    DesktopSingleInstance::Names instanceNames_;
    std::unique_ptr<DesktopSingleInstance::Instance> instanceLock_;
    std::wstring className_; std::vector<Widget> widgets_;
    HFONT fonts_[4]{}; HBRUSH background_, white_, sidebar_;
    UINT dpi_ = 96, taskbarMessage_ = 0; bool trayAdded_ = false, trayTipShown_ = false;
    int page_ = 0, role_ = 0; bool busy_ = false, testing_ = false, proxyAvailable_ = false, statusAvailable_ = false, settingsLoaded_ = false;
    uint64_t viewEpoch_ = 0, lastStatusRevision_ = 0;
    std::atomic<bool> stopping_{false}, ready_{false};
    std::mutex engineMutex_; KernelHandle process_, job_, wake_;
    std::thread pollThread_, actionThread_, testThread_;
    std::string token_, authUrl_, requestId_, invitation_, lastDevices_, lastProxyDevices_, lastConfig_, observedRole_, testScope_;
    Json status_, proxy_ = Json::object(); HWND heading_ = nullptr, description_ = nullptr, state_ = nullptr;
    HWND identityMessage_ = nullptr, networkMessage_ = nullptr, connectionHint_ = nullptr, peerList_ = nullptr, proxyPeerList_ = nullptr, activity_ = nullptr;
    HWND startupHint_ = nullptr, modelStatus_ = nullptr, hostModelStatus_ = nullptr;
    HWND proxyMessage_ = nullptr, proxyDetails_ = nullptr, proxyGuardMessage_ = nullptr, settingsGuardMessage_ = nullptr;

    Json Object(const Json& value, const char* key) const {
        return value.is_object() && value.contains(key) && value[key].is_object() ? value[key] : Json::object();
    }
    Json Identity() const { return Object(status_, "identity"); }
    Json Model() const { return Object(status_, "model"); }
    DesktopAccess::State Access() const { return DesktopAccess::FromStatus(status_, options_.demo); }
    bool Capability(const char* name) const { auto access = Access(); return std::string_view(name) == "model" ? access.model : std::string_view(name) == "proxy" && access.proxy; }
    bool RoleLocked() const { return Access().locked; }
    std::string Role() const { return Access().role; }

    int S(int value) const { return MulDiv(value, static_cast<int>(dpi_), 96); }
    HWND Item(int id) const { return GetDlgItem(window_, id); }
    void Text(HWND target, const std::wstring& value) { if (ControlText(target) != value) SetWindowTextW(target, value.c_str()); }
    void Text(int id, const std::wstring& value) {
        if (id != TEST_OUTPUT) { Text(Item(id), value); return; }
        std::wstring lines; lines.reserve(value.size());
        for (size_t i = 0; i < value.size(); ++i) {
            if (value[i] == L'\n' && (i == 0 || value[i - 1] != L'\r')) lines += L'\r';
            lines += value[i];
        }
        Text(Item(id), lines);
    }
    std::wstring Value(int id) const { return ControlText(Item(id)); }
    int ConfigNumber(int id, int minimum, int maximum, const char* error) const {
        auto value = Value(id); int number = 0;
        if (value.empty()) throw std::runtime_error(error);
        for (auto digit : value) {
            if (digit < L'0' || digit > L'9' || number > (maximum - static_cast<int>(digit - L'0')) / 10) throw std::runtime_error(error);
            number = number * 10 + static_cast<int>(digit - L'0');
        }
        if (number < minimum || number > maximum) throw std::runtime_error(error);
        return number;
    }
    void Message(const std::wstring& text, bool error = false) { MessageBoxW(window_, text.c_str(), APP_TITLE, error ? MB_ICONERROR : MB_ICONINFORMATION); }
    void Report(const std::wstring& text) { Text(state_, text); }
    HWND Add(const wchar_t* type, const wchar_t* text, int id, int x, int y, int w, int h,
             int page = -1, int role = 0, DWORD style = 0, int font = 0,
             bool right = false, bool stretch = false, bool taller = false) {
        const bool edit = wcscmp(type, L"EDIT") == 0 || wcscmp(type, L"COMBOBOX") == 0;
        DWORD extra = edit ? WS_EX_CLIENTEDGE : 0;
        HWND child = CreateWindowExW(extra, type, text, WS_CHILD | WS_VISIBLE | style,
                                     0, 0, 0, 0, window_, reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)), instance_, nullptr);
        if (!child) throw std::runtime_error(WindowsError("创建桌面控件"));
        widgets_.push_back({child, page, role, x, y, w, h, font, right, stretch, taller, false, false, edit});
        SendMessageW(child, WM_SETFONT, reinterpret_cast<WPARAM>(fonts_[font]), FALSE);
        return child;
    }
    HWND Label(const wchar_t* text, int x, int y, int w, int h, int page = -1, int role = 0, int font = 0, bool muted = false) {
        auto child = Add(L"STATIC", text, 0, x, y, w, h, page, role, SS_LEFT, font);
        widgets_.back().muted = muted; return child;
    }
    HWND Button(const wchar_t* text, int id, int x, int y, int w, int h, int page = -1, int role = 0, bool right = false) {
        return Add(L"BUTTON", text, id, x, y, w, h, page, role, WS_TABSTOP | BS_OWNERDRAW, 1, right);
    }
    HWND Edit(const wchar_t* text, int id, int x, int y, int w, int h, int page, int role = 0, bool multiline = false, bool readOnly = false, bool stretch = false, bool taller = false) {
        DWORD style = WS_TABSTOP | (multiline ? ES_MULTILINE | ES_AUTOVSCROLL | WS_VSCROLL | ES_WANTRETURN : ES_AUTOHSCROLL);
        if (readOnly) style |= ES_READONLY;
        auto child = Add(L"EDIT", text, id, x, y, w, h, page, role, style, 0, false, stretch, taller);
        SendMessageW(child, EM_SETLIMITTEXT, multiline ? 2 * 1024 * 1024 : 4096, 0);
        SendMessageW(child, EM_SETMARGINS, EC_LEFTMARGIN | EC_RIGHTMARGIN, MAKELPARAM(S(7), S(7)));
        return child;
    }
    void Fonts() {
        for (auto& font : fonts_) { if (font) DeleteObject(font); font = nullptr; }
        const int size[] = {14, 14, 28, 12};
        for (int i = 0; i < 4; ++i) fonts_[i] = CreateFontW(-S(size[i]), 0, 0, 0, i == 1 || i == 2 ? FW_SEMIBOLD : FW_NORMAL,
                                                          FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                                                          CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Microsoft YaHei UI");
        for (auto& item : widgets_) SendMessageW(item.window, WM_SETFONT, reinterpret_cast<WPARAM>(fonts_[item.font]), TRUE);
    }
    void Layout() {
        RECT rect; GetClientRect(window_, &rect);
        int extraW = std::max(0, MulDiv(rect.right, 96, dpi_) - 1040);
        int extraH = std::max(0, MulDiv(rect.bottom, 96, dpi_) - 760);
        HDWP defer = BeginDeferWindowPos(static_cast<int>(widgets_.size()));
        for (auto& item : widgets_) {
            int x = item.x + (item.right ? extraW : 0), y = item.y;
            int height = item.h;
            if (item.window == proxyPeerList_ && role_ == 2) { y = 346; height = 270; }
            if (item.sidebar && item.y > 600) y += extraH;
            if (item.page == -2) y += extraH;
            defer = DeferWindowPos(defer, item.window, nullptr, S(x), S(y), S(item.w + (item.stretch ? extraW : 0)),
                                   S(height + (item.taller ? extraH : 0)), SWP_NOZORDER | SWP_NOACTIVATE);
        }
        if (defer) EndDeferWindowPos(defer);
        if (peerList_) ListView_SetColumnWidth(peerList_, 0, S(210 + extraW));
        if (proxyPeerList_) ListView_SetColumnWidth(proxyPeerList_, 0, S(230 + extraW));
        InvalidateRect(window_, nullptr, TRUE);
    }
    void Visibility() {
        for (auto& item : widgets_) {
            bool visible = (item.page < 0 || item.page == page_) && (!item.role || item.role == role_);
            ShowWindow(item.window, visible ? SW_SHOWNA : SW_HIDE);
            if (visible) InvalidateRect(item.window, nullptr, TRUE);
        }
        const wchar_t* titles[] = {L"设备与配对", L"模型 API", L"运行记录", L"网络代理", L"设置"};
        const wchar_t* descriptions[] = {L"先确定本机身份，再连接私有网络并配对；退出私有网络后才能切换身份。", role_ == 2 ? L"配置本机 Claude 服务；模型服务与网络共享分别控制。" : L"通过本机 API 调用 B 的 Claude；工具、文件和命令由调用端执行。", L"查看私有网络、配对及两项业务的运行记录。", role_ == 2 ? L"为已配对的调用端提供本机网络出口，独立于 Claude 模型服务。" : L"Clash 负责本机 TUN；本客户端连接 B，并提供持久系统断线保护。", L"管理后台运行、开机启动、系统保护恢复与开源许可。"};
        Text(heading_, titles[page_]); Text(description_, descriptions[page_]);
        InvalidateRect(window_, nullptr, TRUE);
    }
    void InitUi() {
        dpi_ = GetDpiForWindow(window_); Fonts();
        Label(L"BRIDGE.", 24, 30, 150, 42, -1, 0, 2);
        widgets_.back().sidebar = true;
        Label(L"CLAUDE CODE / 私有桥接", 24, 80, 150, 22, -1, 0, 3, true); widgets_.back().sidebar = true;
        Label(L"工作空间", 24, 128, 130, 22, -1, 0, 3, true); widgets_.back().sidebar = true;
        Button(L"设备与配对", NAV_CONNECTION, 16, 166, 152, 40); widgets_.back().sidebar = true;
        Button(L"模型 API", NAV_API, 16, 214, 152, 40); widgets_.back().sidebar = true;
        Button(L"运行记录", NAV_LOGS, 16, 262, 152, 40); widgets_.back().sidebar = true;
        Button(L"网络代理", NAV_PROXY, 16, 310, 152, 40); widgets_.back().sidebar = true;
        Button(L"设置", NAV_SETTINGS, 20, 680, 144, 36); widgets_.back().sidebar = true;
        Label((L"C++ DESKTOP / v" + Wide(BRIDGE_VERSION)).c_str(), 24, 730, 152, 18, -1, 0, 3, true); widgets_.back().sidebar = true;
        heading_ = Label(L"设备与配对", 208, 28, 380, 40, -1, 0, 2);
        state_ = Label(L"正在启动内置服务…", 670, 42, 346, 28, -1, 0, 0); widgets_.back().right = true;
        description_ = Label(L"", 208, 78, 808, 24, -1, 0, 0, true); widgets_.back().stretch = true;
        Label(L"本机身份", 228, 130, 400, 24, 0, 0, 1);
        Button(L"我是 A · 调用端", ROLE_CLIENT, 228, 164, 188, 34, 0);
        Button(L"我是 B · 服务端", ROLE_HOST, 428, 164, 188, 34, 0);
        identityMessage_ = Label(L"请选择身份；连接私有网络后锁定。", 228, 210, 520, 26, 0, 0, 3, true); widgets_.back().stretch = true;
        Button(L"连接私有网络", NETWORK_CONNECT, 774, 130, 218, 34, 0, 0, true);
        Button(L"刷新设备", NETWORK_REFRESH, 774, 174, 104, 32, 0, 0, true);
        Button(L"浏览器登录", NETWORK_LOGIN, 888, 174, 104, 32, 0, 0, true);
        Button(L"退出私网 / 解锁身份", NETWORK_DISCONNECT, 774, 218, 218, 32, 0, 0, true);
        networkMessage_ = Label(L"正在读取私有网络状态…", 228, 248, 520, 36, 0, 0, 3, true); widgets_.back().stretch = true;
        Label(L"设备配对", 228, 330, 200, 24, 0, 0, 1);
        Button(L"忘记配对", PAIR_DISCONNECT, 466, 326, 92, 30, 0);
        Label(L"粘贴 B 服务端的配对码", 228, 372, 330, 22, 0, 1, 3, true);
        Edit(L"", INVITATION, 228, 404, 330, 140, 0, 1, true);
        Button(L"配对并连接 B", PAIR_JOIN, 228, 562, 330, 38, 0, 1);
        Label(L"本机只连接一个 B。配对加密保存在本机，\r\n临时掉线或重启后按原身份自动恢复。", 228, 622, 330, 44, 0, 1, 3, true);
        Label(L"先创建服务身份，再将配对码发送给 A。\r\nClaude 和网络共享可在各自页面单独开启。", 228, 374, 330, 48, 0, 2, 3, true);
        Button(L"创建服务身份与配对码", PAIR_HOST, 228, 440, 330, 38, 0, 2);
        Edit(L"创建服务身份后生成配对码", PAIR_CODE, 228, 498, 330, 100, 0, 2, true, true);
        Button(L"复制配对码", COPY_INVITE, 228, 620, 330, 34, 0, 2);
        Label(L"网络中的设备", 614, 330, 382, 24, 0, 0, 1);
        peerList_ = Add(WC_LISTVIEWW, L"", 0, 614, 368, 382, 148, 0, 0, LVS_REPORT | LVS_SINGLESEL | LVS_NOSORTHEADER, 3, false, true);
        ListView_SetExtendedListViewStyle(peerList_, LVS_EX_FULLROWSELECT | LVS_EX_DOUBLEBUFFER | LVS_EX_LABELTIP);
        const wchar_t* columns[] = {L"设备 / 身份", L"虚拟 IP", L"连接"}; const int widths[] = {210, 104, 64};
        for (int i = 0; i < 3; ++i) { LVCOLUMNW column{}; column.mask = LVCF_TEXT | LVCF_WIDTH; column.pszText = const_cast<LPWSTR>(columns[i]); column.cx = S(widths[i]); ListView_InsertColumn(peerList_, i, &column); }
        Label(L"连接提示", 614, 556, 382, 24, 0, 0, 1);
        connectionHint_ = Label(L"请选择身份并连接私有网络。\r\n私网在线与桥接配对是两个独立状态。", 614, 590, 382, 48, 0, 0, 3, true); widgets_.back().stretch = true;
        Button(L"恢复配对连接", PAIR_RESUME, 614, 646, 182, 30, 0);
        Button(L"暂停配对连接", PAIR_PAUSE, 810, 646, 186, 30, 0, 0, true);

        Label(L"A · Claude 模型调用", 228, 132, 540, 24, 1, 1, 1);
        Label(L"Base URL · OpenAI 兼容接口", 228, 164, 540, 20, 1, 1, 3, true);
        Edit(DesktopModelApi::BaseUrl(options_.port).c_str(), API_ENDPOINT, 228, 188, 540, 30, 1, 1, false, true, true);
        Button(L"复制 Base URL", COPY_ENDPOINT, 784, 188, 208, 30, 1, 1, true);
        Label(L"API Key · 仅供本机调用，以 Bearer 方式认证", 228, 230, 540, 20, 1, 1, 3, true);
        auto apiToken = Edit(L"", API_TOKEN, 228, 254, 540, 30, 1, 1, false, true, true);
        SendMessageW(apiToken, EM_SETPASSWORDCHAR, L'\x25CF', 0);
        Button(L"复制 API Key", COPY_TOKEN, 784, 254, 208, 30, 1, 1, true);
        Label(L"Model ID · claude-code / claude-code-sonnet / claude-code-opus", 228, 296, 540, 20, 1, 1, 3, true);
        Edit(DesktopModelApi::DefaultModel, API_MODEL, 228, 320, 540, 30, 1, 1, false, false, true);
        Button(L"复制 Model ID", COPY_MODEL, 784, 320, 208, 30, 1, 1, true);
        modelStatus_ = Label(L"正在读取 Claude 模型服务状态…", 228, 364, 540, 40, 1, 1, 3, true); widgets_.back().stretch = true;
        Button(L"复制模型 API 示例", COPY_EXAMPLE, 784, 364, 208, 30, 1, 1, true);
        Label(L"Claude 调用测试", 228, 436, 500, 24, 1, 1, 1);
        Edit(L"请用一句话说明你能提供什么帮助", TEST_PROMPT, 228, 472, 620, 48, 1, 1, true, false, true);
        Button(L"发送测试", TEST_SEND, 864, 472, 128, 26, 1, 1, true);
        Button(L"取消调用", TEST_CANCEL, 864, 504, 128, 24, 1, 1, true);
        Edit(L"测试使用上方模型 API；每次测试都是独立请求。", TEST_OUTPUT, 228, 542, 764, 124, 1, 1, true, true, true, true);
        Label(L"B · Claude 服务配置", 228, 132, 540, 24, 1, 2, 1);
        Label(L"Claude 程序路径或命令", 228, 176, 540, 20, 1, 2, 3, true);
        Edit(L"claude", CLAUDE_COMMAND, 228, 204, 540, 30, 1, 2, false, false, true);
        Button(L"检测 Claude", PROBE_CLAUDE, 784, 204, 208, 30, 1, 2, true);
        Label(L"Claude 运行目录", 228, 254, 540, 20, 1, 2, 3, true);
        Edit(L"", WORKSPACE, 228, 282, 540, 30, 1, 2, false, false, true);
        Button(L"选择目录", BROWSE_WORKSPACE, 784, 282, 208, 30, 1, 2, true);
        Label(L"单次最长时间（秒）", 228, 336, 250, 20, 1, 2, 3, true);
        Edit(L"600", MODEL_TIMEOUT, 228, 364, 250, 30, 1, 2);
        Label(L"单次最多推理轮数", 512, 336, 250, 20, 1, 2, 3, true);
        Edit(L"30", MODEL_MAX_TURNS, 512, 364, 250, 30, 1, 2);
        Label(L"先安装并登录 Claude Code，再开启模型服务。\r\n模型请求由已配对的 A 发起；网络共享可独立开启或关闭。", 228, 426, 764, 48, 1, 2, 0, true); widgets_.back().stretch = true;
        Button(L"保存配置并开启模型服务", MODEL_ENABLE, 228, 496, 354, 38, 1, 2);
        Button(L"关闭模型服务", MODEL_DISABLE, 600, 496, 240, 38, 1, 2);
        Label(L"服务状态", 228, 572, 700, 24, 1, 2, 1);
        // A 与 B 使用不同控件，角色切换时不会残留另一端的配置或提示。
        hostModelStatus_ = Label(L"尚未开启模型服务。", 228, 608, 764, 52, 1, 2, 0, true); widgets_.back().stretch = true;

        Label(L"最近活动", 228, 132, 500, 24, 2, 0, 1);
        Button(L"打开数据目录", OPEN_DATA, 840, 128, 152, 32, 2, 0, true);
        activity_ = Edit(L"等待设备连接，记录会显示在这里。", 0, 228, 180, 764, 484, 2, 0, true, true, true, true);
        Label(L"A · Clash 订阅节点", 228, 132, 600, 24, 3, 1, 1);
        Label(L"B · 共享本机网络", 228, 132, 600, 24, 3, 2, 1);
        proxyMessage_ = Label(L"正在读取代理状态…", 228, 168, 764, 40, 3, 0, 0); widgets_.back().stretch = true;
        proxyDetails_ = Label(L"", 228, 214, 764, 22, 3, 0, 3, true); widgets_.back().stretch = true;
        proxyPeerList_ = Add(WC_LISTVIEWW, L"", 0, 228, 246, 764, 76, 3, 0, LVS_REPORT | LVS_SINGLESEL | LVS_NOSORTHEADER, 3, false, true);
        ListView_SetExtendedListViewStyle(proxyPeerList_, LVS_EX_FULLROWSELECT | LVS_EX_DOUBLEBUFFER | LVS_EX_LABELTIP);
        const wchar_t* proxyColumns[] = {L"设备 / 身份", L"虚拟 IP", L"代理状态", L"连接 / 已传输"};
        const int proxyWidths[] = {230, 132, 160, 238};
        for (int i = 0; i < 4; ++i) { LVCOLUMNW column{}; column.mask = LVCF_TEXT | LVCF_WIDTH; column.pszText = const_cast<LPWSTR>(proxyColumns[i]); column.cx = S(proxyWidths[i]); ListView_InsertColumn(proxyPeerList_, i, &column); }
        Button(L"启用本地 Clash 节点", PROXY_ENABLE, 228, 334, 356, 32, 3, 1);
        Button(L"允许已配对的 A 使用本机网络", PROXY_SHARING, 228, 252, 420, 36, 3, 2);
        Label(L"已配对设备与网络使用情况", 228, 310, 700, 24, 3, 2, 1);
        Label(L"Clash 完整配置订阅 · 仅在 A 本机使用", 228, 378, 580, 20, 3, 1, 3, true);
        Edit(L"启用本地节点后生成", PROXY_SUBSCRIPTION, 228, 404, 556, 30, 3, 1, false, true, true);
        Button(L"复制订阅地址", COPY_SUBSCRIPTION, 800, 404, 192, 30, 3, 1, true);
        Label(L"导入完整配置，仅开启 Clash TUN（无需改网卡名）；关闭本机 Clash 的系统代理 / 代理脚本。", 228, 444, 764, 20, 3, 1, 3, true); widgets_.back().stretch = true;
        Label(L"设备在线表示配对连接可用；“使用中”表示该设备正连接网络共享。\r\n停止共享仅关闭代理连接，不会中断 Claude 模型服务。", 228, 634, 764, 42, 3, 2, 3, true); widgets_.back().stretch = true;
        Label(L"本机 · 系统断线保护", 228, 502, 700, 24, 3, 1, 1);
        proxyGuardMessage_ = Label(L"正在读取保护状态…", 228, 536, 764, 40, 3, 1, 3); widgets_.back().stretch = true;
        Button(L"启用 / 刷新保护（UAC）", PROXY_GUARD, 228, 584, 252, 32, 3, 1);
        Button(L"检查保护（UAC）", PROXY_GUARD_VERIFY, 492, 584, 224, 32, 3, 1);
        Button(L"关闭保护并恢复本机直连（UAC）", PROXY_GUARD_DISABLE, 228, 626, 488, 32, 3, 1);
        Label(L"支持 ClaudeBridgeTun / Mihomo；网卡重建后请刷新保护。退出私网或切换身份不会撤除保护。", 228, 666, 764, 18, 3, 1, 3, true); widgets_.back().stretch = true;
        Label(L"后台运行", 228, 132, 540, 24, 4, 0, 1);
        Label(L"最小化或关闭窗口会收起到托盘，连接与服务继续运行。\r\n双击托盘图标可恢复窗口；右键选择“退出”才会停止客户端。", 228, 172, 764, 42, 4, 0, 0, true); widgets_.back().stretch = true;
        Button(L"收起到托盘", MINIMIZE_TRAY, 228, 224, 220, 34, 4);
        Label(L"开机启动", 228, 294, 540, 24, 4, 0, 1);
        Add(L"BUTTON", L"Windows 登录后自动在后台运行", STARTUP_ENABLE, 228, 328, 540, 26, 4, 0, BS_AUTOCHECKBOX | WS_TABSTOP);
        startupHint_ = Label(L"", 228, 364, 764, 40, 4, 0, 3, true); widgets_.back().stretch = true;
        Label(L"系统保护恢复 · 所有身份均可使用", 228, 444, 700, 24, 4, 0, 1);
        settingsGuardMessage_ = Label(L"正在读取保护状态…", 228, 478, 764, 40, 4, 0, 3, true); widgets_.back().stretch = true;
        Button(L"检查保护（UAC）", SETTINGS_GUARD_VERIFY, 228, 530, 224, 32, 4);
        Button(L"关闭保护并恢复本机直连（UAC）", SETTINGS_GUARD_DISABLE, 466, 530, 350, 32, 4);
        Label((L"Claude Bridge · v" + Wide(BRIDGE_VERSION)).c_str(), 228, 628, 540, 24, 4);
        Button(L"开源许可", OPEN_LICENSES, 784, 620, 208, 34, 4, 0, true);
        Label(L"查看本客户端及其所用开源组件的许可与版权说明。", 228, 662, 764, 20, 4, 0, 3, true); widgets_.back().stretch = true;
        LoadSettings(); LoadStartup(); Visibility(); Layout(); UpdateButtons();
    }
    DesktopStartup::Registration Startup() const { return {options_.directory, options_.port, options_.system}; }
    void LoadStartup() {
        EnableWindow(Item(STARTUP_ENABLE), !options_.demo);
        if (options_.demo) { Text(startupHint_, L"演示模式不修改\r\nWindows 自启动设置。"); return; }
        try {
            auto startup = Startup();
            SendMessageW(Item(STARTUP_ENABLE), BM_SETCHECK, startup.Enabled() ? BST_CHECKED : BST_UNCHECKED, 0);
            startup.RefreshIfNewer(DesktopStartup::ExecutablePath(), Wide(BRIDGE_VERSION));
            bool enabled = startup.Enabled();
            SendMessageW(Item(STARTUP_ENABLE), BM_SETCHECK, enabled ? BST_CHECKED : BST_UNCHECKED, 0);
            Text(startupHint_, enabled ? L"已启用 · 登录后在托盘运行。\r\n客户端副本已保存。" : L"未启用 · 勾选一次即可。\r\n仅对当前 Windows 用户生效。");
        } catch (const std::exception& error) { Text(startupHint_, L"自启动设置不可用：\r\n" + Wide(error.what())); }
    }
    void SetStartup() {
        if (options_.demo) return;
        bool requested = SendMessageW(Item(STARTUP_ENABLE), BM_GETCHECK, 0, 0) == BST_CHECKED;
        try {
            auto startup = Startup();
            if (requested) startup.Enable(DesktopStartup::ExecutablePath(), Wide(BRIDGE_VERSION)); else startup.Disable();
            LoadStartup(); Report(requested ? L"已启用开机自启动 · 登录后驻留托盘" : L"已关闭开机自启动");
        } catch (...) { SendMessageW(Item(STARTUP_ENABLE), BM_SETCHECK, requested ? BST_UNCHECKED : BST_CHECKED, 0); throw; }
    }
    void LoadSettings() {
        fs::path ini = options_.directory / L"desktop.ini"; wchar_t buffer[4096];
        GetPrivateProfileStringW(L"host", L"workspace", L"", buffer, 4096, ini.c_str()); Text(WORKSPACE, buffer);
        GetPrivateProfileStringW(L"host", L"claude", L"claude", buffer, 4096, ini.c_str()); Text(CLAUDE_COMMAND, buffer);
        GetPrivateProfileStringW(L"host", L"timeoutSeconds", L"600", buffer, 4096, ini.c_str()); Text(MODEL_TIMEOUT, buffer);
        GetPrivateProfileStringW(L"host", L"maxTurns", L"30", buffer, 4096, ini.c_str()); Text(MODEL_MAX_TURNS, buffer);
        settingsLoaded_ = true;
    }
    void SaveSettings() {
        // WM_CREATE can fail after some inputs exist but before LoadSettings.
        // Its WM_DESTROY/Stop path must not save those defaults over user data.
        if (!settingsLoaded_ || !window_ || !IsWindow(Item(WORKSPACE))) return;
        fs::path ini = options_.directory / L"desktop.ini";
        WritePrivateProfileStringW(L"host", L"workspace", Value(WORKSPACE).c_str(), ini.c_str());
        WritePrivateProfileStringW(L"host", L"claude", Value(CLAUDE_COMMAND).c_str(), ini.c_str());
        WritePrivateProfileStringW(L"host", L"timeoutSeconds", Value(MODEL_TIMEOUT).c_str(), ini.c_str());
        WritePrivateProfileStringW(L"host", L"maxTurns", Value(MODEL_MAX_TURNS).c_str(), ini.c_str());
    }
    void Paint() {
        PAINTSTRUCT ps; HDC dc = BeginPaint(window_, &ps); RECT client; GetClientRect(window_, &client);
        FillRect(dc, &client, background_); RECT side{0, 0, S(184), client.bottom}; FillRect(dc, &side, sidebar_);
        int width = MulDiv(client.right, 96, dpi_), height = MulDiv(client.bottom, 96, dpi_);
        HPEN pen = CreatePen(PS_SOLID, 1, LINE); auto oldPen = SelectObject(dc, pen); auto oldBrush = SelectObject(dc, white_);
        auto card = [&](int x, int y, int w, int h) { RoundRect(dc, S(x), S(y), S(x + w), S(y + h), S(12), S(12)); };
        int extraW = std::max(0, width - 1040), extraH = std::max(0, height - 760);
        if (page_ == 0) { card(208, 112, 808 + extraW, 184); card(208, 312, 370, 374); card(594, 312, 422 + extraW, 220); card(594, 540, 422 + extraW, 146); }
        if (page_ == 1) { if (role_ == 2) card(208, 112, 808 + extraW, 574 + extraH); else { card(208, 112, 808 + extraW, 300); card(208, 420, 808 + extraW, 266 + extraH); } }
        if (page_ == 2) card(208, 112, 808 + extraW, 574 + extraH);
        if (page_ == 3) { if (role_ == 2) card(208, 112, 808 + extraW, 574 + extraH); else { card(208, 112, 808 + extraW, 362); card(208, 486, 808 + extraW, 200 + extraH); } }
        if (page_ == 4) { card(208, 112, 808 + extraW, 160); card(208, 280, 808 + extraW, 136); card(208, 430, 808 + extraW, 154); card(208, 600, 808 + extraW, 86); }
        SelectObject(dc, oldPen); SelectObject(dc, oldBrush); DeleteObject(pen); EndPaint(window_, &ps);
    }
    void DrawButton(DRAWITEMSTRUCT* draw) {
        int id = static_cast<int>(draw->CtlID);
        if (draw->CtlType != ODT_BUTTON) return;
        bool nav = id >= NAV_CONNECTION && id <= NAV_SETTINGS, side = nav;
        bool selected = (nav && page_ == id - NAV_CONNECTION) || (id == ROLE_CLIENT && role_ == 1) || (id == ROLE_HOST && role_ == 2);
        bool primary = id == PAIR_JOIN || id == PAIR_HOST || id == NETWORK_CONNECT || id == TEST_SEND;
        bool disabled = draw->itemState & ODS_DISABLED;
        COLORREF fill = side ? (selected ? RGB(43, 54, 73) : SIDEBAR) : primary ? ACCENT : selected ? RGB(249, 234, 228) : RGB(255, 255, 255);
        if (draw->itemState & ODS_SELECTED) fill = side ? RGB(51, 64, 84) : primary ? RGB(150, 64, 44) : RGB(237, 240, 244);
        if (disabled && !side) fill = RGB(238, 240, 243);
        HPEN pen = CreatePen(PS_SOLID, 1, side ? fill : selected || primary ? ACCENT : LINE);
        HBRUSH brush = CreateSolidBrush(fill); auto oldPen = SelectObject(draw->hDC, pen); auto oldBrush = SelectObject(draw->hDC, brush);
        RoundRect(draw->hDC, draw->rcItem.left, draw->rcItem.top, draw->rcItem.right, draw->rcItem.bottom, S(7), S(7));
        SetBkMode(draw->hDC, TRANSPARENT); SetTextColor(draw->hDC, disabled ? RGB(153, 160, 171) : side || primary ? RGB(249, 250, 252) : selected ? ACCENT : INK);
        auto oldFont = SelectObject(draw->hDC, fonts_[1]); auto text = ControlText(draw->hwndItem);
        RECT rect = draw->rcItem; DrawTextW(draw->hDC, text.c_str(), -1, &rect, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
        if (draw->itemState & ODS_FOCUS) { InflateRect(&rect, -S(3), -S(3)); DrawFocusRect(draw->hDC, &rect); }
        SelectObject(draw->hDC, oldFont); SelectObject(draw->hDC, oldPen); SelectObject(draw->hDC, oldBrush); DeleteObject(pen); DeleteObject(brush);
    }
    void Tray(bool add, bool balloon = false) {
        NOTIFYICONDATAW icon{}; icon.cbSize = sizeof(icon); icon.hWnd = window_; icon.uID = 1;
        icon.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP; icon.uCallbackMessage = MSG_TRAY;
        icon.hIcon = LoadIconW(instance_, MAKEINTRESOURCEW(101));
        wcscpy_s(icon.szTip, L"Claude Bridge · 后台运行");
        if (balloon) {
            icon.uFlags |= NIF_INFO; icon.dwInfoFlags = NIIF_INFO;
            wcscpy_s(icon.szInfoTitle, L"Claude Bridge 已收起到托盘");
            wcscpy_s(icon.szInfo, L"配对连接和服务继续运行。双击图标恢复，右键可退出。");
        }
        if (add) {
            trayAdded_ = Shell_NotifyIconW(NIM_ADD, &icon);
            if (trayAdded_) { icon.uVersion = NOTIFYICON_VERSION_4; Shell_NotifyIconW(NIM_SETVERSION, &icon); }
        } else if (trayAdded_) Shell_NotifyIconW(NIM_MODIFY, &icon);
    }
    void HideToTray() {
        if (!trayAdded_) Tray(true);
        if (!trayAdded_) { Message(L"无法创建托盘图标，窗口将保持可见。", true); return; }
        SaveSettings(); ShowWindow(window_, SW_HIDE);
        if (!trayTipShown_) { Tray(false, true); trayTipShown_ = true; }
    }
    void Restore() { ShowWindow(window_, SW_RESTORE); SetForegroundWindow(window_); }
    void TrayMenu() {
        HMENU menu = CreatePopupMenu(); AppendMenuW(menu, MF_STRING, TRAY_RESTORE, L"打开主窗口");
        AppendMenuW(menu, MF_STRING, TRAY_HIDE, L"收起到托盘"); AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
        AppendMenuW(menu, MF_STRING | (IsWindowEnabled(Item(PAIR_RESUME)) ? 0 : MF_GRAYED), PAIR_RESUME, L"恢复配对连接");
        AppendMenuW(menu, MF_STRING | (IsWindowEnabled(Item(PAIR_PAUSE)) ? 0 : MF_GRAYED), PAIR_PAUSE, L"暂停配对连接（保留身份）");
        AppendMenuW(menu, MF_STRING | (IsWindowEnabled(Item(PAIR_DISCONNECT)) ? 0 : MF_GRAYED), PAIR_DISCONNECT, L"忘记配对");
        AppendMenuW(menu, MF_STRING | (IsWindowEnabled(Item(NETWORK_DISCONNECT)) ? 0 : MF_GRAYED), NETWORK_DISCONNECT, L"退出私网 / 解锁身份");
        AppendMenuW(menu, MF_SEPARATOR, 0, nullptr); AppendMenuW(menu, MF_STRING, TRAY_EXIT, L"退出客户端");
        SetMenuDefaultItem(menu, TRAY_RESTORE, FALSE); POINT point; GetCursorPos(&point); SetForegroundWindow(window_);
        int command = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_NONOTIFY, point.x, point.y, 0, window_, nullptr);
        DestroyMenu(menu); PostMessageW(window_, WM_NULL, 0, 0); if (command) Command(command);
    }
    void Post(Reply reply) {
        if (stopping_) return;
        auto message = std::make_unique<Reply>(std::move(reply));
        if (PostMessageW(window_, MSG_REPLY, 0, reinterpret_cast<LPARAM>(message.get()))) message.release();
    }
    fs::path ExtractEngine() {
        HRSRC resource = FindResourceW(instance_, MAKEINTRESOURCEW(102), RT_RCDATA);
        if (!resource) throw std::runtime_error("内置引擎资源缺失");
        DWORD size = SizeofResource(instance_, resource);
        auto data = static_cast<const unsigned char*>(LockResource(LoadResource(instance_, resource)));
        if (!data || Sha256(data, size) != ENGINE_SHA256) throw std::runtime_error("内置引擎校验失败");
        auto directory = options_.directory / L"engine" / Wide(BRIDGE_VERSION) / Wide(std::string(ENGINE_SHA256).substr(0, 20));
        fs::create_directories(directory);
        auto target = directory / L"bridge-engine.exe";
        if (fs::is_regular_file(target) && fs::file_size(target) == size) {
            std::ifstream source(target, std::ios::binary); std::vector<unsigned char> existing(size);
            if (source.read(reinterpret_cast<char*>(existing.data()), size) && Sha256(existing.data(), existing.size()) == ENGINE_SHA256) return target;
        }
        auto temporary = directory / (L"engine-" + std::to_wstring(GetCurrentProcessId()) + L".tmp");
        try {
            { std::ofstream file(temporary, std::ios::binary | std::ios::trunc); file.write(reinterpret_cast<const char*>(data), size); file.flush(); if (!file) throw std::runtime_error("解包内置引擎失败"); }
            if (!MoveFileExW(temporary.c_str(), target.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) throw std::runtime_error(WindowsError("写入内置引擎"));
        } catch (...) { std::error_code error; fs::remove(temporary, error); throw; }
        return target;
    }
    void StartEngine() {
        bool occupied = false;
        // A killed desktop releases its mutex before Windows finishes closing
        // every child. Let its local listener disappear before starting ours.
        for (int attempt = 0; attempt < 30 && !stopping_; ++attempt) {
            occupied = LocalHttpListening(options_.port);
            if (!occupied) break;
            if (WaitForSingleObject(wake_.value, 100) == WAIT_OBJECT_0) return;
        }
        if (occupied) throw std::runtime_error("本地端口已被其他程序占用，请关闭占用程序，或使用 --port 指定空闲端口");
        auto engine = ExtractEngine();
        std::lock_guard lock(engineMutex_); if (stopping_) return;
        if (!job_.value) throw std::runtime_error("后台进程作业尚未就绪");
        auto command = QuoteArgument(engine.wstring()) + L" --owned-engine --no-browser --port " + std::to_wstring(options_.port)
                     + L" --data-dir " + QuoteArgument(options_.directory.wstring());
        if (options_.demo) command += L" --demo";
        if (options_.system) command += L" --system-tailscale";
        STARTUPINFOW startup{}; startup.cb = sizeof(startup); startup.dwFlags = STARTF_USESHOWWINDOW; startup.wShowWindow = SW_HIDE;
        PROCESS_INFORMATION child{};
        if (!CreateProcessW(engine.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW | CREATE_SUSPENDED,
                            nullptr, options_.directory.c_str(), &startup, &child)) throw std::runtime_error(WindowsError("启动内置引擎"));
        process_.reset(child.hProcess); KernelHandle thread(child.hThread);
        if (!AssignProcessToJobObject(job_.value, process_.value)) { TerminateProcess(process_.value, 1); throw std::runtime_error(WindowsError("托管后台进程")); }
        if (ResumeThread(thread.value) == static_cast<DWORD>(-1)) {
            auto error = WindowsError("运行内置引擎"); TerminateJobObject(job_.value, 1); throw std::runtime_error(error);
        }
    }
    bool EngineExited(DWORD* exitCode = nullptr) {
        std::lock_guard lock(engineMutex_);
        if (!process_.value || WaitForSingleObject(process_.value, 0) != WAIT_OBJECT_0) return false;
        if (exitCode && !GetExitCodeProcess(process_.value, exitCode)) *exitCode = 1;
        return true;
    }
    void Poll() {
        try {
            StartEngine(); if (stopping_) return;
            bool started = false;
            for (int i = 0; i < 120 && !stopping_; ++i) {
                try {
                    auto health = Api(options_.port, "", L"/health");
                    if (health.value("service", "") != "claude-p2p-bridge" || health.value("version", "") != BRIDGE_VERSION) throw std::runtime_error("本地端口返回了其他程序的数据");
                    if (health.value("parentPid", DWORD{0}) != GetProcessId(process_.value)) throw std::runtime_error("正在等待本次启动的引擎");
                    auto boot = Api(options_.port, "", L"/api/bootstrap"); token_ = boot.at("token").get<std::string>();
                    started = true; ready_ = true; Post({"ready", boot}); break;
                } catch (...) {
                    DWORD exitCode = 1;
                    if (EngineExited(&exitCode)) {
                        // The local API can receive a shutdown request before
                        // this startup poll has finished its first bootstrap.
                        if (exitCode == 0) { PostMessageW(window_, MSG_EXIT, 0, 0); return; }
                        throw std::runtime_error("内置引擎启动失败，请在数据目录查看 client.log，或检查端口是否被占用");
                    }
                }
                if (WaitForSingleObject(wake_.value, 100) == WAIT_OBJECT_0) return;
            }
            if (!started) { if (!stopping_) throw std::runtime_error("内置引擎启动超时，请检查 client.log"); return; }
            int count = 0;
            while (!stopping_) {
                if (EngineExited()) { PostMessageW(window_, MSG_EXIT, 0, 0); return; }
                try { Post({"status", Api(options_.port, token_, L"/api/status")}); }
                catch (const std::exception& error) { Post({"poll-error", {}, error.what()}); }
                if (count++ % 3 == 0) {
                    // Refresh network inventory, then render a versioned full
                    // snapshot so an old poll cannot undo an identity change.
                    try { Api(options_.port, token_, L"/api/tailscale", nullptr, 5000); Post({"status", Api(options_.port, token_, L"/api/status")}); }
                    catch (const std::exception& error) { Post({"network-error", {}, error.what()}); }
                }
                if (WaitForSingleObject(wake_.value, 1800) == WAIT_OBJECT_0) break;
            }
        } catch (const std::exception& error) { Post({"startup-error", {}, error.what()}); }
    }
    void UpdateButtons() {
        bool enabled = ready_ && statusAvailable_ && Identity().value("loaded", false) && !busy_;
        auto identity = Identity();
        const auto role = Role();
        const bool locked = RoleLocked();
        const bool networkReady = Access().networkReady;
        EnableWindow(Item(ROLE_CLIENT), enabled && !locked && !testing_);
        EnableWindow(Item(ROLE_HOST), enabled && !locked && !testing_);
        EnableWindow(Item(NETWORK_CONNECT), enabled && !role.empty() && !locked);
        EnableWindow(Item(NETWORK_DISCONNECT), enabled && locked);
        EnableWindow(Item(NETWORK_REFRESH), enabled && locked);
        EnableWindow(Item(NETWORK_LOGIN), enabled && locked && !authUrl_.empty());
        EnableWindow(Item(PAIR_JOIN), enabled && role == "client" && networkReady);
        EnableWindow(Item(PAIR_HOST), enabled && role == "host" && networkReady);
        EnableWindow(Item(PROBE_CLAUDE), enabled && role == "host" && Capability("model"));
        EnableWindow(Item(MODEL_ENABLE), enabled && role == "host" && Capability("model"));
        EnableWindow(Item(MODEL_DISABLE), enabled && role == "host" && Capability("model") && Model().value("enabled", false));
        EnableWindow(Item(NAV_API), ready_ && Capability("model"));
        EnableWindow(Item(NAV_PROXY), ready_ && Capability("proxy"));
        EnableWindow(Item(COPY_INVITE), enabled && !invitation_.empty());
        EnableWindow(Item(COPY_TOKEN), ready_ && Capability("model")); EnableWindow(Item(COPY_EXAMPLE), ready_ && Capability("model"));
        bool online = role == "client" && Model().value("online", false) && Model().value("available", false);
        EnableWindow(Item(TEST_SEND), ready_ && !busy_ && Capability("model") && online && !testing_);
        EnableWindow(Item(TEST_CANCEL), testing_ && !requestId_.empty() && !busy_);
        auto pairing = status_.is_object() ? status_.value("pairing", Json::object()) : Json::object();
        bool saved = pairing.is_object() && pairing.value("saved", false);
        bool paused = pairing.is_object() && pairing.value("state", "") == "paused";
        EnableWindow(Item(PAIR_DISCONNECT), enabled && saved);
        EnableWindow(Item(PAIR_RESUME), enabled && saved && networkReady && (paused || !status_.value("online", false)));
        EnableWindow(Item(PAIR_PAUSE), enabled && saved && !paused);
        const auto guard = proxy_.value("guard", Json::object());
        EnableWindow(Item(PROXY_ENABLE), enabled && proxyAvailable_ && Capability("proxy") && role == "client");
        EnableWindow(Item(PROXY_SHARING), enabled && proxyAvailable_ && Capability("proxy") && role == "host");
        EnableWindow(Item(COPY_SUBSCRIPTION), enabled && proxyAvailable_ && !proxy_.value("subscriptionUrl", "").empty());
        bool guardSupported = enabled && proxyAvailable_ && guard.is_object() && guard.value("supported", false);
        EnableWindow(Item(PROXY_GUARD), guardSupported && role == "client" && Capability("proxy") && proxy_.value("enabled", false));
        EnableWindow(Item(PROXY_GUARD_VERIFY), guardSupported);
        EnableWindow(Item(PROXY_GUARD_DISABLE), guardSupported);
        EnableWindow(Item(SETTINGS_GUARD_VERIFY), guardSupported);
        EnableWindow(Item(SETTINGS_GUARD_DISABLE), guardSupported);
    }
    void RenderProxy(const Json& proxy) {
        if (!proxy.is_object()) return;
        proxyAvailable_ = true;
        proxy_ = proxy;
        const auto phase = proxy.value("state", "disabled");
        const bool host = Role() == "host";
        const bool sharing = proxy.value("sharing", false);
        std::wstring state = host ? (sharing ? L"本机网络共享已开启" : L"本机网络共享未开启") : phase == "ready" && proxy.value("online", false) ? L"B 出口已连接" : phase == "blocked" ? L"B 不可用 · 代理请求已阻断" : phase == "waiting" ? L"等待 B · 自动重连中" : L"代理未启用";
        Text(proxyMessage_, state + L"\r\n" + Wide(proxy.value("message", "")));
        const std::wstring endpoint = host ? L"B 网络共享" : L"A → B 独立代理连接";
        Text(proxyDetails_, endpoint + L" · 活跃连接 " + std::to_wstring(proxy.value("connections", 0)) + (sharing ? L" · B 共享已开启" : L" · B 共享已关闭"));
        Text(PROXY_ENABLE, proxy.value("enabled", false) ? L"关闭本地 Clash 节点" : L"启用本地 Clash 节点");
        Text(PROXY_SHARING, proxy.value("sharing", false) ? L"停止共享本机网络" : L"允许已配对的 A 使用本机网络");
        auto subscription = proxy.value("subscriptionUrl", "");
        Text(PROXY_SUBSCRIPTION, subscription.empty() ? L"启用本地节点后生成" : Wide(subscription));
        const auto guard = proxy.value("guard", Json::object());
        const bool active = guard.is_object() && guard.value("active", false);
        const bool unknown = guard.is_object() && (guard.value("state", "") == "unknown" || guard.value("verification", "") == "unknown");
        const bool partial = guard.is_object() && guard.value("state", "") == "partial";
        auto guardMessage = std::wstring(unknown ? L"保护状态未验证，请检查或明确关闭" : partial ? L"保护规则未通过校验" : active ? L"系统保护已验证生效" : L"系统保护未启用") + L"\r\n" + Wide(guard.is_object() ? guard.value("message", "") : "");
        Text(proxyGuardMessage_, guardMessage); Text(settingsGuardMessage_, guardMessage);
        RenderDevices(proxyPeerList_, proxy.value("devices", Json::array()), lastProxyDevices_, true);
        UpdateButtons();
    }
    void RenderDevices(HWND list, const Json& devices, std::string& previous, bool proxy = false) {
        if (!devices.is_array()) return;
        auto serialized = devices.dump();
        if (serialized == previous) return;
        ListView_DeleteAllItems(list); int row = 0;
        for (const auto& device : devices) {
            if (!device.is_object()) continue;
            const bool self = device.value("self", false), online = device.value("online", false);
            auto name = Wide(device.value("name", "未命名设备"));
            auto role = device.value("role", Json());
            std::wstring identity = self ? L"本机" : L"";
            const auto roleText = role == "host" ? L"B 服务端" : role == "client" ? L"A 调用端" : L"";
            if (*roleText) { if (!identity.empty()) identity += L" · "; identity += roleText; }
            if (!identity.empty()) name = identity + L"｜" + name;
            auto address = Wide(device.value("address", "")); if (address.empty()) address = L"尚未分配";
            const auto path = device.value("path", "");
            std::wstring connection = !online ? L"离线" : self ? L"在线" : path == "direct" ? L"P2P 直连" : path == "relay" || path == "peer-relay" ? L"加密中转" : L"在线";
            if (proxy && online && !self) connection = device.value("usingProxy", false) ? L"使用中" : L"已配对 · 空闲";
            LVITEMW item{}; item.mask = LVIF_TEXT; item.iItem = row; item.pszText = name.data(); ListView_InsertItem(list, &item);
            ListView_SetItemText(list, row, 1, address.data()); ListView_SetItemText(list, row, 2, connection.data());
            if (proxy) {
                const auto bytes = device.value("uploadBytes", uint64_t{0}) + device.value("downloadBytes", uint64_t{0});
                std::wostringstream usage; usage << device.value("connections", 0) << L" 个 / ";
                if (bytes < 1024) usage << bytes << L" B";
                else usage << std::fixed << std::setprecision(1) << (static_cast<double>(bytes) / (bytes < 1024 * 1024 ? 1024.0 : 1024.0 * 1024.0)) << (bytes < 1024 * 1024 ? L" KiB" : L" MiB");
                auto text = usage.str(); ListView_SetItemText(list, row, 3, text.data());
            }
            ++row;
        }
        if (!row) { std::wstring empty = proxy ? L"暂无已配对设备" : L"连接私有网络后显示设备"; LVITEMW item{}; item.mask = LVIF_TEXT; item.pszText = empty.data(); ListView_InsertItem(list, &item); }
        previous = serialized;
    }
    void RenderNetwork(const Json& network) {
        std::string message = network.value("message", "等待网络连接");
        if (options_.demo) message = "演示模式 · 仅用于本机模拟 Claude，不连接真实账号或调用模型";
        Text(networkMessage_, Wide(message));
        std::string login = network.value("authUrl", ""); authUrl_ = SafeLoginUrl(login) ? login : "";
        const Json devices = network.contains("devices") && network["devices"].is_array() ? network["devices"] : network.value("peers", Json::array());
        RenderDevices(peerList_, devices, lastDevices_);
        UpdateButtons();
    }
    void RenderStatus(const Json& status) {
        auto revision = status.value("revision", uint64_t{0});
        if (revision < lastStatusRevision_) return;
        lastStatusRevision_ = revision;
        statusAvailable_ = true;
        status_ = status;
        const auto identity = Identity();
        const auto role = Role();
        bool online = status.value("online", false);
        int connectedClients = status.value("connectedClients", 0);
        Report(online ? (role == "host" ? L"B 服务端 · " + std::to_wstring(connectedClients) + L" 个 A 已连接" : L"A 调用端 · 已配对连接") : !role.empty() ? (RoleLocked() ? L"身份已锁定 · 等待连接" : L"私有网络已退出") : L"请选择本机身份");
        auto pairing = status.value("pairing", Json::object());
        auto model = Model();
        Text(modelStatus_, Wide(model.value("message", "等待 B 的 Claude 模型服务。")) + L"\r\n网络代理独立运行；模型不可用不会切断网络代理。");
        Text(hostModelStatus_, Wide(model.value("message", "尚未开启 Claude 模型服务。")));
        Text(MODEL_ENABLE, model.value("enabled", false) ? L"保存配置并更新模型服务" : L"保存配置并开启模型服务");
        Text(identityMessage_, Wide(identity.value("message", RoleLocked() ? "身份已锁定；先退出私有网络才能切换。" : "请选择身份，再连接私有网络。")));
        bool roleChanged = role != observedRole_;
        const auto testScope = DesktopAccess::ModelTestScope(status);
        if (roleChanged || testScope != testScope_) {
            ++viewEpoch_; requestId_.clear(); testScope_ = testScope;
            Text(TEST_OUTPUT, testing_ ? L"连接或授权已改变，本次测试已停止；连接就绪后可重新测试。" : L"每次测试都是独立请求。");
        }
        if (roleChanged) { role_ = role == "host" ? 2 : role == "client" ? 1 : 0; page_ = 0; lastProxyDevices_.clear(); }
        if ((page_ == 1 && !Capability("model")) || (page_ == 3 && !Capability("proxy"))) page_ = 0;
        observedRole_ = role;
        if (pairing.is_object()) Text(PAIR_HOST, pairing.value("saved", false) && role == "host" ? L"重新创建服务身份与配对码" : L"创建服务身份与配对码");
        invitation_ = status.value("invitation", Json()).is_string() ? status["invitation"].get<std::string>() : "";
        Text(PAIR_CODE, invitation_.empty() ? L"创建服务身份后生成配对码" : Wide(invitation_));
        if (status.contains("network") && status["network"].is_object()) RenderNetwork(status["network"]);
        if (status.contains("proxy")) RenderProxy(status["proxy"]);
        const auto config = Object(model, "config");
        if (role == "host" && !config.empty() && config.dump() != lastConfig_) {
            Text(WORKSPACE, Wide(config.value("workspace", ""))); Text(CLAUDE_COMMAND, Wide(config.value("claudeCommand", "claude")));
            Text(MODEL_TIMEOUT, std::to_wstring(config.value("timeoutMs", 600000) / 1000));
            Text(MODEL_MAX_TURNS, std::to_wstring(config.value("maxTurns", 30)));
            lastConfig_ = config.dump();
        }
        std::wstring hint = role.empty() ? L"先选择调用端或服务端，再连接私有网络。" : !RoleLocked() ? L"私有网络已退出；可以切换身份。\r\n未明确关闭的系统保护仍会保留。" : L"两端登录同一私有网络后进行桥接配对。\r\n临时掉线不会解除身份锁定。";
        if (pairing.is_object() && (pairing.value("saved", false) || pairing.value("state", "none") == "error")) {
            hint = Wide(pairing.value("message", "")) + L"\r\n" + Wide(DesktopAccess::PairingRecoveryHint(pairing, identity.value("desiredOnline", false)));
        }
        if (role == "host" && online) hint = L"已配对连接 " + std::to_wstring(connectedClients) + L" 个 A。\r\n模型服务与网络共享可分别启停。\r\n退出私网后才可切换身份。";
        Text(connectionHint_, hint);
        if (status.contains("logs")) {
            std::wstring logs;
            for (const auto& log : status["logs"]) logs += Wide(log.value("time", "")) + L"\r\n" + Wide(log.value("message", "")) + L"\r\n\r\n";
            Text(activity_, logs.empty() ? L"等待设备连接，记录会显示在这里。" : logs);
        }
        Visibility(); if (roleChanged) Layout(); UpdateButtons();
    }
    void Action(std::wstring route, Json body, const std::string& kind) {
        if (!ready_ || busy_) return;
        if (actionThread_.joinable()) actionThread_.join();
        busy_ = true; UpdateButtons(); Report(L"正在处理…");
        actionThread_ = std::thread([this, route = std::move(route), body = std::move(body), kind] {
            try { Post({kind, Api(options_.port, token_, route, route == L"/api/tailscale" || (route == L"/api/proxy" && kind == "proxy-copy") ? nullptr : &body, route == L"/api/proxy/guard" || route == L"/api/proxy/guard/verify" ? 330000 : 30000)}); }
            catch (const std::exception& error) { Post({"action-error", {}, error.what()}); }
        });
    }
    void StartTest() {
        if (testing_ || !statusAvailable_ || Role() != "client" || !Capability("model") || !Model().value("available", false)) return;
        auto prompt = Utf8(Value(TEST_PROMPT)); if (prompt.empty()) throw std::runtime_error("请先输入要发送给 Claude 的内容");
        auto model = Utf8(Value(API_MODEL)); if (model.empty()) throw std::runtime_error("请填写 Model ID");
        Json body = {{"model", model}, {"messages", Json::array({{{"role", "user"}, {"content", prompt}}})}, {"stream", true}};
        if (testThread_.joinable()) testThread_.join();
        testing_ = true; requestId_.clear(); Text(TEST_OUTPUT, L"正在调用 B 的 Claude…"); UpdateButtons();
        testThread_ = std::thread([this, body, epoch = viewEpoch_] {
            std::string output, id; bool done = false;
            try {
                LocalRequest request(options_.port, token_, L"/v1/chat/completions", &body, 25000);
                if (request.status != 200) request.ReadJson();
                id = request.RequestId(); Post({"test-start", {}, {}, id, epoch});
                SseDecoder decoder; char chunk[8192]; DWORD received;
                while (!stopping_ && !done) {
                    received = request.ReadAvailable(chunk, sizeof(chunk));
                    if (!received) break;
                    for (const auto& event : decoder.Feed(std::string_view(chunk, received))) {
                        if (event.value("type", "") == "sse-done") done = true;
                        if (event.contains("error")) throw std::runtime_error(event["error"].value("message", "Claude 模型调用失败"));
                        if (event.contains("choices") && event["choices"].is_array()) for (const auto& choice : event["choices"]) {
                            if (choice.value("index", 0) != 0) continue;
                            auto delta = choice.value("delta", Json::object());
                            if (delta.value("content", Json()).is_string()) output += delta["content"].get<std::string>();
                            if (choice.value("finish_reason", Json()).is_string()) done = true;
                        }
                        if (output.size() > 2 * 1024 * 1024) throw std::runtime_error("输出已超过桌面显示上限，请通过 API 读取大型结果");
                        Post({"test-progress", {}, output.empty() ? "正在等待 Claude 完成推理…" : output, id, epoch});
                        if (done) break;
                    }
                }
                if (!done && !stopping_) throw std::runtime_error("连接已结束，未收到模型调用完成事件");
                Post({"test-done", {}, output, id, epoch});
            } catch (const std::exception& error) { Post({"test-done", {}, output + "\n" + error.what(), id, epoch}); }
        });
    }
    void OnReply(const Reply& reply) {
        if (reply.kind == "ready") { Text(API_TOKEN, Wide(token_)); Report(L"服务已就绪 · 尚未配对"); UpdateButtons(); return; }
        if (reply.kind == "startup-error") { Report(L"启动失败"); Message(Wide(reply.text), true); return; }
        if (reply.kind == "poll-error") {
            Report(L"本机服务暂时不可用"); proxyAvailable_ = false; statusAvailable_ = false;
            Text(proxyMessage_, L"本地桥接服务不可用 · 请检查后台进程。\r\n代理连接状态无法确认，等待服务恢复。");
            Text(proxyGuardMessage_, L"当前无法读取系统保护状态；请检查本地服务。\r\n此前已启用的系统保护需明确关闭才恢复直连。");
            Text(settingsGuardMessage_, L"本地服务不可用，当前无法确认系统保护状态。\r\n此前已启用的保护仍须明确关闭才恢复直连。");
            UpdateButtons(); return;
        }
        if (reply.kind == "network-error") { Text(networkMessage_, Wide(reply.text)); return; }
        if (reply.kind == "status") { if (!busy_) RenderStatus(reply.data); return; }
        if (reply.kind == "network") { RenderNetwork(reply.data); return; }
        if (reply.kind == "test-start") { if (reply.viewEpoch == viewEpoch_) requestId_ = reply.requestId; UpdateButtons(); return; }
        if (reply.kind == "test-progress" || reply.kind == "test-done") {
            if (reply.viewEpoch == viewEpoch_) Text(TEST_OUTPUT, Wide(reply.text.empty() ? reply.kind == "test-done" ? "调用已完成（无文本输出）" : "正在等待 Claude…" : reply.text));
            if (reply.kind == "test-done") { testing_ = false; requestId_.clear(); if (testThread_.joinable()) testThread_.join(); }
            UpdateButtons(); return;
        }
        busy_ = false; if (actionThread_.joinable()) actionThread_.join(); UpdateButtons();
        if (reply.kind == "action-error") { Report(L"操作失败"); Message(Wide(reply.text), true); return; }
        if (reply.kind == "login" || reply.kind == "refresh") {
            if (reply.data.contains("identity")) RenderStatus(reply.data); else RenderNetwork(reply.data);
            if (reply.kind == "login" && !authUrl_.empty()) OpenLink(window_, Wide(authUrl_));
            return;
        }
        if (reply.kind == "probe") { Message(Wide(reply.data.value("message", "检测完成")), !reply.data.value("available", false)); return; }
        if (reply.kind == "cancel") { Report(L"已发送取消请求"); return; }
        if (reply.kind == "proxy" || reply.kind == "proxy-copy") {
            RenderProxy(reply.data.contains("proxy") ? reply.data["proxy"] : reply.data);
            if (reply.kind == "proxy-copy") {
                auto subscription = proxy_.value("subscriptionUrl", "");
                if (subscription.empty()) Message(L"请先启用本地 Clash 节点。", true);
                else { Clipboard(window_, Wide(subscription)); Report(L"完整配置订阅已复制 · 请在 Clash 导入并开启 TUN"); }
            } else Report(Wide(proxy_.value("message", "代理设置已更新")));
            return;
        }
        RenderStatus(reply.data);
    }
    void Browse() {
        IFileDialog* dialog = nullptr;
        if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog)))) throw std::runtime_error("无法打开目录选择器");
        DWORD flags; dialog->GetOptions(&flags); dialog->SetOptions(flags | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
        dialog->SetTitle(L"选择 B 端的 Claude 项目目录");
        if (SUCCEEDED(dialog->Show(window_))) {
            IShellItem* item = nullptr; if (SUCCEEDED(dialog->GetResult(&item))) {
                PWSTR path = nullptr; if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &path))) { Text(WORKSPACE, path); CoTaskMemFree(path); SaveSettings(); }
                item->Release();
            }
        }
        dialog->Release();
    }
    void Command(int id) {
        try {
            switch (id) {
            case NAV_CONNECTION: case NAV_API: case NAV_LOGS: case NAV_PROXY: case NAV_SETTINGS:
                if ((id == NAV_API && !Capability("model")) || (id == NAV_PROXY && !Capability("proxy"))) break;
                page_ = id - NAV_CONNECTION; Visibility(); break;
            case ROLE_CLIENT: case ROLE_HOST:
                if (statusAvailable_ && Identity().value("loaded", false) && !RoleLocked() && !testing_) Action(L"/api/identity", {{"role", id == ROLE_CLIENT ? "client" : "host"}}, "identity");
                break;
            case MINIMIZE_TRAY: case TRAY_HIDE: HideToTray(); break;
            case TRAY_RESTORE: Restore(); break;
            case TRAY_EXIT: DestroyWindow(window_); break;
            case STARTUP_ENABLE: SetStartup(); break;
            case NETWORK_CONNECT: Action(L"/api/network/login", Json::object(), "login"); break;
            case NETWORK_DISCONNECT: Action(L"/api/network/disconnect", Json::object(), "network-disconnect"); break;
            case NETWORK_REFRESH: Action(L"/api/tailscale", Json::object(), "refresh"); break;
            case NETWORK_LOGIN: if (!authUrl_.empty() && SafeLoginUrl(authUrl_)) OpenLink(window_, Wide(authUrl_)); break;
            case PAIR_JOIN: Action(L"/api/join", {{"invitation", Utf8(Value(INVITATION))}}, "join"); break;
            case PAIR_HOST: Action(L"/api/host", Json::object(), "host"); break;
            case MODEL_ENABLE: {
                int seconds = ConfigNumber(MODEL_TIMEOUT, 1, 3600, "单次最长时间必须为 1–3600 秒");
                int turns = ConfigNumber(MODEL_MAX_TURNS, 1, 200, "单次推理轮数必须为 1–200 的整数");
                SaveSettings(); Action(L"/api/model", {{"enabled", true}, {"workspace", Utf8(Value(WORKSPACE))}, {"claudeCommand", Utf8(Value(CLAUDE_COMMAND))}, {"timeoutMs", seconds * 1000}, {"maxTurns", turns}}, "model"); break;
            }
            case MODEL_DISABLE: Action(L"/api/model", {{"enabled", false}}, "model"); break;
            case PAIR_DISCONNECT: Action(L"/api/disconnect", Json::object(), "disconnect"); break;
            case PAIR_PAUSE: Action(L"/api/pause", Json::object(), "pause"); break;
            case PAIR_RESUME: Action(L"/api/reconnect", Json::object(), "reconnect"); break;
            case BROWSE_WORKSPACE: Browse(); break;
            case PROBE_CLAUDE: Action(L"/api/probe", {{"claudeCommand", Utf8(Value(CLAUDE_COMMAND))}}, "probe"); break;
            case PROXY_ENABLE: Action(L"/api/proxy", {{"enabled", !proxy_.value("enabled", false)}}, "proxy"); break;
            case PROXY_SHARING: Action(L"/api/proxy", {{"sharing", !proxy_.value("sharing", false)}}, "proxy"); break;
            case COPY_SUBSCRIPTION: Action(L"/api/proxy", Json::object(), "proxy-copy"); break;
            case PROXY_GUARD: Action(L"/api/proxy/guard", {{"enabled", true}}, "proxy"); break;
            case PROXY_GUARD_VERIFY: case SETTINGS_GUARD_VERIFY: Action(L"/api/proxy/guard/verify", Json::object(), "proxy"); break;
            case PROXY_GUARD_DISABLE: case SETTINGS_GUARD_DISABLE: Action(L"/api/proxy/guard", {{"enabled", false}}, "proxy"); break;
            case COPY_INVITE: Clipboard(window_, Wide(invitation_)); Report(L"配对码已复制"); break;
            case COPY_ENDPOINT: Clipboard(window_, Value(API_ENDPOINT)); Report(L"模型 Base URL 已复制"); break;
            case COPY_TOKEN: Clipboard(window_, Wide(token_)); Report(L"API 令牌已复制"); break;
            case COPY_MODEL: Clipboard(window_, Value(API_MODEL)); Report(L"Model ID 已复制"); break;
            case COPY_EXAMPLE: {
                Clipboard(window_, DesktopModelApi::PowerShellExample(options_.directory, options_.port)); Report(L"模型 API 的 PowerShell 示例已复制"); break;
            }
            case TEST_SEND: StartTest(); break;
            case TEST_CANCEL: if (!requestId_.empty()) Action(L"/v1/requests/" + Wide(requestId_) + L"/cancel", Json::object(), "cancel"); break;
            case OPEN_DATA: OpenLink(window_, options_.directory.wstring()); break;
            case OPEN_LICENSES: OpenLink(window_, L"http://127.0.0.1:" + std::to_wstring(options_.port) + L"/licenses"); break;
            }
        } catch (const std::exception& error) { Message(Wide(error.what()), true); }
    }
    void Stop() {
        if (stopping_.exchange(true)) return;
        SaveSettings(); SetEvent(wake_.value);
        {
            std::lock_guard lock(engineMutex_);
            if (process_.value && WaitForSingleObject(process_.value, 0) == WAIT_TIMEOUT) {
                if (ready_) { try { Json body = Json::object(); Api(options_.port, token_, L"/api/shutdown", &body, 1000); } catch (...) {} }
                WaitForSingleObject(process_.value, 1500);
            }
            DrainOwnedJob(job_.value, process_.value);
            job_.reset();
        }
        for (auto* thread : {&pollThread_, &actionThread_, &testThread_}) if (thread->joinable()) thread->join();
        if (trayAdded_) { NOTIFYICONDATAW icon{}; icon.cbSize = sizeof(icon); icon.hWnd = window_; icon.uID = 1; Shell_NotifyIconW(NIM_DELETE, &icon); trayAdded_ = false; }
        MSG message; while (PeekMessageW(&message, window_, MSG_REPLY, MSG_REPLY, PM_REMOVE)) delete reinterpret_cast<Reply*>(message.lParam);
    }
    LRESULT Handle(UINT message, WPARAM wParam, LPARAM lParam) {
        if (message == taskbarMessage_) { trayAdded_ = false; Tray(true); if (!trayAdded_) Restore(); return 0; }
        switch (message) {
        case WM_CREATE:
            // A normal launch may need to restore this same-user window after
            // it was started elevated. Only the harmless restore IPC is allowed.
            ChangeWindowMessageFilterEx(window_, MSG_RESTORE, MSGFLT_ALLOW, nullptr);
            InitUi(); Tray(true); return 0;
        case WM_PAINT: Paint(); return 0;
        case WM_ERASEBKGND: return 1;
        case WM_DRAWITEM: DrawButton(reinterpret_cast<DRAWITEMSTRUCT*>(lParam)); return TRUE;
        case WM_CTLCOLORSTATIC: case WM_CTLCOLOREDIT: case WM_CTLCOLORBTN: {
            HDC dc = reinterpret_cast<HDC>(wParam); HWND child = reinterpret_cast<HWND>(lParam);
            for (const auto& item : widgets_) if (item.window == child) {
                SetTextColor(dc, item.sidebar ? item.muted ? RGB(155, 168, 189) : RGB(249, 250, 252) : item.muted ? MUTED : INK);
                SetBkMode(dc, OPAQUE);
                COLORREF color = item.sidebar ? SIDEBAR : item.edit || item.page >= 0 ? RGB(255, 255, 255) : BACKGROUND;
                SetBkColor(dc, color);
                return reinterpret_cast<LRESULT>(item.sidebar ? sidebar_ : item.edit || item.page >= 0 ? white_ : background_);
            }
            break;
        }
        case WM_COMMAND: if (HIWORD(wParam) == BN_CLICKED || HIWORD(wParam) == 0) Command(LOWORD(wParam)); return 0;
        case WM_CLOSE: HideToTray(); return 0;
        case WM_SIZE: if (wParam == SIZE_MINIMIZED) HideToTray(); else Layout(); return 0;
        case WM_DPICHANGED: { dpi_ = HIWORD(wParam); Fonts(); auto rect = reinterpret_cast<RECT*>(lParam); SetWindowPos(window_, nullptr, rect->left, rect->top, rect->right - rect->left, rect->bottom - rect->top, SWP_NOZORDER | SWP_NOACTIVATE); Layout(); return 0; }
        case WM_GETMINMAXINFO: { auto info = reinterpret_cast<MINMAXINFO*>(lParam); RECT rect{0, 0, S(1040), S(760)}; AdjustWindowRectExForDpi(&rect, WS_OVERLAPPEDWINDOW, FALSE, 0, dpi_); info->ptMinTrackSize = {rect.right - rect.left, rect.bottom - rect.top}; return 0; }
        case WM_QUERYENDSESSION: return TRUE;
        case WM_ENDSESSION: if (wParam) { Stop(); DestroyWindow(window_); } return 0;
        case MSG_TRAY: { UINT event = LOWORD(lParam); if (event == WM_LBUTTONDBLCLK || event == NIN_SELECT || event == NIN_KEYSELECT) Restore(); if (event == WM_CONTEXTMENU || event == WM_RBUTTONUP) TrayMenu(); return 0; }
        case MSG_RESTORE: Restore(); return 0;
        case MSG_EXIT: DestroyWindow(window_); return 0;
        case MSG_REPLY: { std::unique_ptr<Reply> reply(reinterpret_cast<Reply*>(lParam)); if (!stopping_) { try { OnReply(*reply); } catch (const std::exception& error) { Report(Wide(error.what())); } } return 0; }
        case WM_DESTROY: Stop(); PostQuitMessage(0); return 0;
        }
        return DefWindowProcW(window_, message, wParam, lParam);
    }
    static LRESULT CALLBACK WindowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
        auto self = reinterpret_cast<Application*>(GetWindowLongPtrW(window, GWLP_USERDATA));
        if (message == WM_NCCREATE) { self = static_cast<Application*>(reinterpret_cast<CREATESTRUCTW*>(lParam)->lpCreateParams); self->window_ = window; SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self)); }
        if (!self) return DefWindowProcW(window, message, wParam, lParam);
        try { return self->Handle(message, wParam, lParam); }
        catch (const std::exception& error) { MessageBoxW(window, Wide(error.what()).c_str(), APP_TITLE, MB_ICONERROR); return message == WM_CREATE ? -1 : 0; }
    }
public:
    Application(HINSTANCE instance, Options options) : options_(std::move(options)), instance_(instance) {
#ifdef BRIDGE_DESKTOP_TEST_NAMESPACE
        instanceNames_ = DesktopSingleInstance::TestNames(BRIDGE_DESKTOP_TEST_NAMESPACE);
#endif
        className_ = instanceNames_.windowClass;
        background_ = CreateSolidBrush(BACKGROUND); white_ = CreateSolidBrush(RGB(255, 255, 255)); sidebar_ = CreateSolidBrush(SIDEBAR);
        wake_.reset(CreateEventW(nullptr, TRUE, FALSE, nullptr)); taskbarMessage_ = RegisterWindowMessageW(L"TaskbarCreated");
    }
    ~Application() { Stop(); for (auto font : fonts_) if (font) DeleteObject(font); DeleteObject(background_); DeleteObject(white_); DeleteObject(sidebar_); }
    int Run() {
        // The member outlives Stop(), including startup exceptions. Keep the
        // user-wide lock until every owned engine/job has finished shutting down.
        instanceLock_ = std::make_unique<DesktopSingleInstance::Instance>(instanceNames_);
        if (!instanceLock_->AcquireOrActivate(options_.minimized, APP_TITLE, MSG_RESTORE)) return 0;
        // An abandoned mutex can become available before a killed desktop's
        // children finish exiting. Drain its stable user-wide job before any
        // profile writes, even when the next launch changes port or directory.
        PrepareOwnedJob(job_, instanceLock_->JobName());
        fs::create_directories(options_.directory);
        DataDirectoryLock profile(options_.directory);
        if (!profile.Acquired()) throw std::runtime_error("此数据目录仍被其他客户端或后台进程使用，请先正常退出占用程序，再启动本客户端。");
        INITCOMMONCONTROLSEX controls{sizeof(controls), ICC_STANDARD_CLASSES | ICC_LISTVIEW_CLASSES}; InitCommonControlsEx(&controls);
        WNDCLASSEXW type{}; type.cbSize = sizeof(type); type.hInstance = instance_; type.lpfnWndProc = WindowProc;
        type.lpszClassName = className_.c_str(); type.hCursor = LoadCursorW(nullptr, IDC_ARROW); type.hIcon = LoadIconW(instance_, MAKEINTRESOURCEW(101)); type.hIconSm = type.hIcon;
        if (!RegisterClassExW(&type)) throw std::runtime_error(WindowsError("注册窗口"));
        dpi_ = GetDpiForSystem(); RECT rect{0, 0, S(1040), S(760)}; AdjustWindowRectExForDpi(&rect, WS_OVERLAPPEDWINDOW, FALSE, 0, dpi_);
        RECT work; SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
        int width = rect.right - rect.left, height = rect.bottom - rect.top;
        window_ = CreateWindowExW(0, className_.c_str(), APP_TITLE, WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
                                  std::max(work.left, work.left + (work.right - work.left - width) / 2),
                                  std::max(work.top, work.top + (work.bottom - work.top - height) / 2), width, height,
                                  nullptr, nullptr, instance_, this);
        if (!window_) throw std::runtime_error(WindowsError("创建主窗口"));
        if (options_.minimized && trayAdded_) HideToTray(); else ShowWindow(window_, SW_SHOWNORMAL);
        UpdateWindow(window_); pollThread_ = std::thread([this] { Poll(); });
        MSG message;
        while (GetMessageW(&message, nullptr, 0, 0) > 0) if (!IsDialogMessageW(window_, &message)) { TranslateMessage(&message); DispatchMessageW(&message); }
        return 0;
    }
};
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
    HRESULT com = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    try {
        PWSTR local = nullptr;
        if (FAILED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &local))) throw std::runtime_error("无法找到本机数据目录");
        auto defaultDirectory = fs::path(local) / L"ClaudeBridge"; CoTaskMemFree(local);
        int count = 0; auto args = CommandLineToArgvW(GetCommandLineW(), &count);
        if (!args) throw std::runtime_error("无法读取启动参数");
        std::unique_ptr<wchar_t*, decltype(&LocalFree)> allocation(args, LocalFree);
        std::vector<std::wstring> arguments(args + 1, args + count);
        auto options = DesktopCli::Parse(arguments, defaultDirectory);
        if (options.version) { const char text[] = "Claude Bridge " BRIDGE_VERSION " / C++ native desktop / embedded Tailscale\n"; DWORD written; WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text, sizeof(text) - 1, &written, nullptr); if (SUCCEEDED(com)) CoUninitialize(); return 0; }
        Application application(instance, std::move(options)); int result = application.Run();
        if (SUCCEEDED(com)) CoUninitialize();
        return result;
    } catch (const std::exception& error) { MessageBoxW(nullptr, Wide(error.what()).c_str(), APP_TITLE, MB_ICONERROR); if (SUCCEEDED(com)) CoUninitialize(); return 1; }
}
