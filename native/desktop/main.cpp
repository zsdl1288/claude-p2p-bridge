#include "platform.hpp"
#include "ids.hpp"
#include "build_config.hpp"
#include "startup.hpp"
#include "profile-lock.hpp"
#include "model-api.hpp"
#include "network-diagnostics.hpp"
#include "speed-test.hpp"
#include "options.hpp"
#include "role-ui.hpp"
#include "theme.hpp"
#include "connection-status.hpp"
#include "pairing-ui.hpp"
#include "single-instance.hpp"
#include "job-lifecycle.hpp"
#include <uxtheme.h>

#ifndef BRIDGE_DIAGNOSTICS_BUILD
#define BRIDGE_DIAGNOSTICS_BUILD 0
#endif
#ifndef BRIDGE_BUILD_LABEL
#define BRIDGE_BUILD_LABEL ""
#endif

namespace {
constexpr UINT_PTR DIAGNOSTICS_TIMER = 1;
constexpr UINT_PTR SPEED_TEST_TIMER = 2;
#if BRIDGE_DIAGNOSTICS_BUILD
constexpr wchar_t APP_TITLE[] = L"Claude Bridge · 本地诊断版";
#else
constexpr wchar_t APP_TITLE[] = L"Claude Bridge · C++ 桌面版";
#endif
using Options = DesktopCli::Options;
struct Reply { std::string kind; Json data; std::string text, requestId; uint64_t viewEpoch = 0; };
struct Widget {
    HWND window; int page, role, x, y, w, h, font; bool right = false, stretch = false, taller = false;
    bool sidebar = false, muted = false, edit = false, bottom = false;
};

class Application {
    Options options_; HINSTANCE instance_; HWND window_ = nullptr;
    DesktopSingleInstance::Names instanceNames_;
    std::unique_ptr<DesktopSingleInstance::Instance> instanceLock_;
    std::wstring className_; std::vector<Widget> widgets_;
    HFONT fonts_[4]{}, iconFont_ = nullptr;
    HBRUSH background_ = nullptr, surface_ = nullptr, sidebar_ = nullptr, input_ = nullptr;
    bool dark_ = false;
    DesktopTheme::Palette colors_ = DesktopTheme::Colors(false);
    DesktopConnectionStatus::Tone statusTone_ = DesktopConnectionStatus::Tone::Waiting;
    HWND hovered_ = nullptr;
    UINT dpi_ = 96, taskbarMessage_ = 0; bool trayAdded_ = false, trayTipShown_ = false;
    int page_ = 0, role_ = 0; bool busy_ = false, testing_ = false, proxyAvailable_ = false, statusAvailable_ = false, settingsLoaded_ = false;
    uint64_t viewEpoch_ = 0, lastStatusRevision_ = 0;
    std::atomic<bool> stopping_{false}, ready_{false};
    std::mutex engineMutex_; KernelHandle process_, job_, wake_;
    std::thread pollThread_, actionThread_, testThread_, diagnosticsThread_, speedTestThread_, speedStatusThread_, speedCancelThread_;
    std::mutex speedCancelMutex_;
    std::condition_variable speedCancelWake_;
    std::string pendingSpeedCancel_;
    bool speedCancelStopping_ = false;
    HWND diagnosticsWindow_ = nullptr, diagnosticsOutput_ = nullptr, diagnosticsRefresh_ = nullptr, diagnosticsClose_ = nullptr;
    HFONT diagnosticsFont_ = nullptr;
    bool diagnosticsBusy_ = false, diagnosticsReadPending_ = false;
    uint64_t diagnosticsEpoch_ = 0;
    HWND speedTestWindow_ = nullptr, speedTestTarget_ = nullptr, speedTestStart_ = nullptr, speedTestCancel_ = nullptr, speedTestExport_ = nullptr, speedTestOutput_ = nullptr, speedTestClose_ = nullptr;
    HWND speedTestDownload_ = nullptr, speedTestDownloadSecondary_ = nullptr, speedTestUpload_ = nullptr, speedTestUploadSecondary_ = nullptr;
    HWND speedTestLatency_ = nullptr, speedTestSamples_ = nullptr, speedTestProgress_ = nullptr, speedTestPhase_ = nullptr, speedTestLabels_[3]{};
    HFONT speedTestFont_ = nullptr, speedTestValueFont_ = nullptr;
    bool speedStatusBusy_ = false;
    ULONGLONG speedLastPoll_ = 0;
    Json speedTestState_ = Json::object(), speedTestReport_;
    std::vector<std::string> speedTestTargets_;
    std::vector<bool> speedTestSupported_;
    std::string lastSpeedTestTargets_, speedTestScope_;
    bool speedTestCommandBusy_ = false;
    uint64_t speedTestView_ = 0;
    DesktopSpeedTest::StatusEpoch speedStatusEpoch_;
    DesktopSpeedTest::OwnedJobs ownedSpeedTests_;
    std::string token_, authUrl_, requestId_, invitation_, lastDevices_, lastProxyDevices_, lastConfig_, lastModels_, observedRole_, testScope_;
    std::vector<std::wstring> modelIds_;
    std::wstring selectedModel_;
    Json status_, proxy_ = Json::object(); HWND heading_ = nullptr, description_ = nullptr, state_ = nullptr;
    HWND identityMessage_ = nullptr, networkMessage_ = nullptr, connectionHint_ = nullptr, peerList_ = nullptr, proxyPeerList_ = nullptr, activity_ = nullptr;
    HWND startupHint_ = nullptr, modelStatus_ = nullptr, hostModelStatus_ = nullptr;
    HWND pairingCaption_ = nullptr;
    bool pairingSummaryShown_ = false;
    HWND proxyMessage_ = nullptr, proxyDetails_ = nullptr;

    Json Object(const Json& value, const char* key) const {
        return value.is_object() && value.contains(key) && value[key].is_object() ? value[key] : Json::object();
    }
    Json Identity() const { return Object(status_, "identity"); }
    Json Model() const { return Object(status_, "model"); }
    Json ModelApi() const { return Object(status_, "modelApi"); }
    int ControlPort() const { return options_.port == 65535 ? 65534 : options_.port + 1; }
    DesktopAccess::State Access() const { return DesktopAccess::FromStatus(status_, options_.demo); }
    bool Capability(const char* name) const { auto access = Access(); return std::string_view(name) == "model" ? access.model : std::string_view(name) == "proxy" && access.proxy; }
    bool RoleLocked() const { return Access().locked; }
    std::string Role() const { return Access().role; }

    int S(int value) const { return MulDiv(value, static_cast<int>(dpi_), 96); }
    HWND Item(int id) const { return GetDlgItem(window_, id); }
    void Text(HWND target, const std::wstring& value) {
        const bool message = target == description_ || target == state_ || target == identityMessage_ || target == networkMessage_ || target == connectionHint_ || target == modelStatus_ || target == hostModelStatus_ || target == proxyMessage_ || target == proxyDetails_ || target == activity_;
        const auto display = message ? DesktopAccess::DisplayRoleNames(value) : value;
        if (ControlText(target) != display) SetWindowTextW(target, display.c_str());
    }
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
    std::wstring SelectedModel() const {
        const auto selected = SendMessageW(Item(API_MODEL), CB_GETCURSEL, 0, 0);
        return selected >= 0 && static_cast<size_t>(selected) < modelIds_.size() ? modelIds_[selected] : L"";
    }
    bool ModelsReady() const {
        return statusAvailable_ && Role() == "client" && status_.value("online", false) &&
            Model().value("modelsState", "unavailable") == "ready" && !SelectedModel().empty();
    }
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
    void Message(const std::wstring& text, bool error = false) { MessageBoxW(window_, DesktopAccess::DisplayRoleNames(text).c_str(), APP_TITLE, error ? MB_ICONERROR : MB_ICONINFORMATION); }
    // Short operation feedback must not replace the durable connection indicator.
    void Report(const std::wstring& text) { Text(description_, text); }
    void SetStatus(const std::wstring& text, DesktopConnectionStatus::Tone tone) {
        statusTone_ = tone; Text(state_, text); PositionStatus();
        InvalidateRect(state_, nullptr, TRUE);
    }
    void PositionStatus() {
        if (!state_) return;
        RECT client; GetClientRect(window_, &client);
        auto dc = GetDC(state_); auto oldFont = SelectObject(dc, fonts_[3]);
        auto text = ControlText(state_); SIZE size{};
        GetTextExtentPoint32W(dc, text.c_str(), static_cast<int>(text.size()), &size);
        SelectObject(dc, oldFont); ReleaseDC(state_, dc);
        const int width = std::clamp(static_cast<int>(size.cx) + S(42), S(150), S(396));
        SetWindowPos(state_, nullptr, client.right - S(24) - width, S(32), width, S(34), SWP_NOZORDER | SWP_NOACTIVATE);
    }
    static LRESULT CALLBACK ControlProc(HWND child, UINT message, WPARAM wParam, LPARAM lParam, UINT_PTR, DWORD_PTR data) {
        auto self = reinterpret_cast<Application*>(data);
        if (GetDlgCtrlID(child) == STARTUP_ENABLE) {
            if (message == WM_PAINT) { self->DrawCheckbox(child); return 0; }
            if (message == WM_ERASEBKGND) return 1;
        }
        if (message == WM_MOUSEMOVE) {
            if (self->hovered_ != child) {
                auto previous = self->hovered_; self->hovered_ = child;
                if (previous) InvalidateRect(previous, nullptr, FALSE);
                InvalidateRect(child, nullptr, FALSE);
                TRACKMOUSEEVENT tracking{sizeof(tracking), TME_LEAVE, child, 0}; TrackMouseEvent(&tracking);
            }
        } else if (message == WM_MOUSELEAVE) {
            if (self->hovered_ == child) self->hovered_ = nullptr;
            InvalidateRect(child, nullptr, FALSE);
        } else if (message == WM_SETFOCUS || message == WM_KILLFOCUS) {
            auto result = DefSubclassProc(child, message, wParam, lParam);
            RedrawWindow(child, nullptr, nullptr, RDW_INVALIDATE | RDW_FRAME); return result;
        } else if (message == WM_NCPAINT && (GetWindowLongPtrW(child, GWL_STYLE) & WS_BORDER)) {
            auto result = DefSubclassProc(child, message, wParam, lParam);
            auto dc = GetWindowDC(child); RECT rect; GetWindowRect(child, &rect);
            OffsetRect(&rect, -rect.left, -rect.top);
            auto brush = CreateSolidBrush(GetFocus() == child ? self->colors_.muted : self->colors_.line);
            FrameRect(dc, &rect, brush); DeleteObject(brush); ReleaseDC(child, dc); return result;
        }
        return DefSubclassProc(child, message, wParam, lParam);
    }
    void DrawCheckbox(HWND child) {
        PAINTSTRUCT ps; auto dc = BeginPaint(child, &ps); RECT rect; GetClientRect(child, &rect);
        FillRect(dc, &rect, surface_);
        const bool enabled = IsWindowEnabled(child), checked = SendMessageW(child, BM_GETCHECK, 0, 0) == BST_CHECKED;
        auto ink = enabled ? colors_.ink : colors_.disabledInk;
        RECT box{0, (rect.bottom - S(14)) / 2, S(14), (rect.bottom + S(14)) / 2};
        auto pen = CreatePen(PS_SOLID, 1, enabled ? colors_.muted : colors_.line);
        auto brush = CreateSolidBrush(checked ? colors_.primary : colors_.input);
        auto oldPen = SelectObject(dc, pen); auto oldBrush = SelectObject(dc, brush);
        RoundRect(dc, box.left, box.top, box.right, box.bottom, S(4), S(4));
        if (checked) {
            auto check = CreatePen(PS_SOLID, std::max(1, S(2)), colors_.primaryInk); SelectObject(dc, check);
            MoveToEx(dc, S(3), box.top + S(7), nullptr); LineTo(dc, S(6), box.top + S(10)); LineTo(dc, S(11), box.top + S(4));
            SelectObject(dc, pen); DeleteObject(check);
        }
        SelectObject(dc, oldPen); SelectObject(dc, oldBrush); DeleteObject(pen); DeleteObject(brush);
        auto oldFont = SelectObject(dc, fonts_[0]); SetBkMode(dc, TRANSPARENT); SetTextColor(dc, ink);
        auto text = ControlText(child); rect.left += S(23);
        DrawTextW(dc, text.c_str(), -1, &rect, DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX);
        if (GetFocus() == child && !(SendMessageW(child, WM_QUERYUISTATE, 0, 0) & UISF_HIDEFOCUS)) DrawFocusRect(dc, &rect);
        SelectObject(dc, oldFont); EndPaint(child, &ps);
    }
    HWND Add(const wchar_t* type, const wchar_t* text, int id, int x, int y, int w, int h,
             int page = -1, int role = 0, DWORD style = 0, int font = 0,
             bool right = false, bool stretch = false, bool taller = false) {
        const bool edit = wcscmp(type, L"EDIT") == 0 || wcscmp(type, L"COMBOBOX") == 0;
        HWND child = CreateWindowExW(0, type, text, WS_CHILD | WS_VISIBLE | style | (edit ? WS_BORDER : 0),
                                     0, 0, 0, 0, window_, reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)), instance_, nullptr);
        if (!child) throw std::runtime_error(WindowsError("创建桌面控件"));
        widgets_.push_back({child, page, role, x, y, w, h, font, right, stretch, taller, false, false, edit});
        SendMessageW(child, WM_SETFONT, reinterpret_cast<WPARAM>(fonts_[font]), FALSE);
        SetWindowSubclass(child, ControlProc, 1, reinterpret_cast<DWORD_PTR>(this));
        return child;
    }
    HWND Label(const wchar_t* text, int x, int y, int w, int h, int page = -1, int role = 0, int font = 0, bool muted = false) {
        auto child = Add(L"STATIC", text, 0, x, y, w, h, page, role, SS_LEFT, font);
        widgets_.back().muted = muted; return child;
    }
    HWND Button(const wchar_t* text, int id, int x, int y, int w, int h, int page = -1, int role = 0, bool right = false) {
        return Add(L"BUTTON", text, id, x, y, w, h, page, role, WS_TABSTOP | BS_OWNERDRAW, 1, right);
    }
    HWND Edit(const wchar_t* text, int id, int x, int y, int w, int h, int page, int role = 0, bool multiline = false, bool readOnly = false, bool stretch = false, bool taller = false, bool scroll = true) {
        DWORD style = WS_TABSTOP | (multiline ? ES_MULTILINE | ES_AUTOVSCROLL | (scroll ? WS_VSCROLL : 0) | ES_WANTRETURN : ES_AUTOHSCROLL);
        if (readOnly) style |= ES_READONLY;
        auto child = Add(L"EDIT", text, id, x, y, w, h, page, role, style, 0, false, stretch, taller);
        SendMessageW(child, EM_SETLIMITTEXT, multiline ? 2 * 1024 * 1024 : 4096, 0);
        SendMessageW(child, EM_SETMARGINS, EC_LEFTMARGIN | EC_RIGHTMARGIN, MAKELPARAM(S(7), S(7)));
        return child;
    }
    void Fonts() {
        for (auto& font : fonts_) { if (font) DeleteObject(font); font = nullptr; }
        if (iconFont_) DeleteObject(iconFont_);
        iconFont_ = CreateFontW(-S(17), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
            OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe MDL2 Assets");
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
            if (item.sidebar && item.y > 600) y += extraH;
            if (item.page == -2) y += extraH;
            if (item.bottom) y += extraH;
            defer = DeferWindowPos(defer, item.window, nullptr, S(x), S(y), S(item.w + (item.stretch ? extraW : 0)),
                                   S(height + (item.taller ? extraH : 0)), SWP_NOZORDER | SWP_NOACTIVATE);
        }
        if (defer) EndDeferWindowPos(defer);
        PositionStatus();
        if (peerList_) ListView_SetColumnWidth(peerList_, 0, S(210 + extraW));
        if (proxyPeerList_) {
            RECT client; GetClientRect(proxyPeerList_, &client);
            const int available = std::max(0, static_cast<int>(client.right) - GetSystemMetricsForDpi(SM_CXVSCROLL, dpi_) - S(4));
            const int fixed[] = {S(106), S(100), S(104), S(250)};
            const int total = fixed[0] + fixed[1] + fixed[2] + fixed[3];
            ListView_SetColumnWidth(proxyPeerList_, 0, std::max(S(90), available - total));
            for (int i = 0; i < 4; ++i) ListView_SetColumnWidth(proxyPeerList_, i + 1, fixed[i]);
        }
        InvalidateRect(window_, nullptr, TRUE);
    }
    void Visibility() {
        for (auto& item : widgets_) {
            bool visible = (item.page < 0 || item.page == page_) && (!item.role || item.role == role_);
            ShowWindow(item.window, visible ? SW_SHOWNA : SW_HIDE);
            if (visible) InvalidateRect(item.window, nullptr, TRUE);
        }
        const wchar_t* titles[] = {L"设备与配对", L"模型 API", L"运行记录", L"网络代理", L"设置"};
        const wchar_t* descriptions[] = {L"先确定本机身份，再连接私有网络并配对；退出私有网络后才能切换身份。", role_ == 2 ? L"配置本机 Claude 服务；模型服务与网络共享分别控制。" : L"通过本机 API 调用服务端的 Claude；工具、文件和命令由调用端执行。", L"仅显示本次运行的记录；退出客户端后清空，不保存到磁盘。", role_ == 2 ? L"为已配对的调用端提供本机网络出口，独立于 Claude 模型服务。" : L"Clash 负责本机 TUN；本客户端连接服务端，提供网络共享节点。", L"管理后台运行、开机启动与开源许可。"};
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
        Button(L"深色模式", THEME_TOGGLE, 16, 634, 152, 36); widgets_.back().sidebar = true;
        Button(L"设置", NAV_SETTINGS, 16, 680, 152, 36); widgets_.back().sidebar = true;
        Label((L"C++ DESKTOP / v" + Wide(BRIDGE_VERSION)).c_str(), 24, 730, 152, 18, -1, 0, 3, true); widgets_.back().sidebar = true;
        heading_ = Label(L"设备与配对", 208, 28, 380, 40, -1, 0, 2);
        state_ = Add(L"STATIC", L"正在启动内置服务…", CONNECTION_STATUS, 670, 32, 346, 34, -1, 0, SS_OWNERDRAW, 3, true);
        description_ = Label(L"", 208, 78, 808, 24, -1, 0, 0, true); widgets_.back().stretch = true;
        Label(L"本机身份", 228, 130, 400, 24, 0, 0, 1);
        Button(L"我是调用端", ROLE_CLIENT, 228, 164, 188, 34, 0);
        Button(L"我是服务端", ROLE_HOST, 428, 164, 188, 34, 0);
        identityMessage_ = Label(L"请选择身份；连接私有网络后锁定。", 228, 210, 520, 26, 0, 0, 3, true); widgets_.back().stretch = true;
        Button(L"连接私有网络", NETWORK_CONNECT, 774, 130, 218, 34, 0, 0, true);
        Button(L"刷新设备", NETWORK_REFRESH, 774, 174, 104, 32, 0, 0, true);
        Button(L"浏览器登录", NETWORK_LOGIN, 888, 174, 104, 32, 0, 0, true);
        Button(L"退出私网 / 解锁身份", NETWORK_DISCONNECT, 774, 218, 218, 32, 0, 0, true);
        networkMessage_ = Label(L"正在读取私有网络状态…", 228, 248, 520, 36, 0, 0, 3, true); widgets_.back().stretch = true;
        Label(L"设备配对", 228, 330, 200, 24, 0, 0, 1);
        pairingCaption_ = Label(L"粘贴服务端的配对码", 228, 372, 330, 22, 0, 1, 3, true);
        Edit(L"", INVITATION, 228, 404, 330, 164, 0, 1, true, false, false, true, false); widgets_.back().font = 3;
        SendMessageW(Item(INVITATION), WM_SETFONT, reinterpret_cast<WPARAM>(fonts_[3]), FALSE);
        Button(L"配对并连接服务端", PAIR_JOIN, 228, 588, 330, 40, 0, 1); widgets_.back().bottom = true;
        Label(L"每台调用端连接一个服务端。配对加密保存在本机，\r\n暂停或临时掉线会保留配对信息。", 228, 650, 330, 52, 0, 1, 3, true); widgets_.back().bottom = true;
        Label(L"先创建服务身份，再将配对码发送给调用端。\r\nClaude 和网络共享可在各自页面单独开启。", 228, 374, 330, 48, 0, 2, 3, true);
        Button(L"创建服务身份与配对码", PAIR_HOST, 228, 440, 330, 40, 0, 2);
        Edit(L"创建服务身份后生成配对码", PAIR_CODE, 228, 500, 330, 128, 0, 2, true, true, false, true, false); widgets_.back().font = 3;
        SendMessageW(Item(PAIR_CODE), WM_SETFONT, reinterpret_cast<WPARAM>(fonts_[3]), FALSE);
        Button(L"复制配对码", COPY_INVITE, 228, 650, 200, 36, 0, 2); widgets_.back().bottom = true;
        Button(L"忘记配对", PAIR_DISCONNECT, 440, 650, 118, 36, 0, 2); widgets_.back().bottom = true;
        Label(L"网络中的设备", 614, 330, 382, 24, 0, 0, 1);
        peerList_ = Add(WC_LISTVIEWW, L"", 0, 614, 368, 382, 212, 0, 0, LVS_REPORT | LVS_SINGLESEL | LVS_NOSORTHEADER, 3, false, true, true);
        ListView_SetExtendedListViewStyle(peerList_, LVS_EX_FULLROWSELECT | LVS_EX_DOUBLEBUFFER | LVS_EX_LABELTIP);
        const wchar_t* columns[] = {L"设备 / 身份", L"虚拟 IP", L"连接"}; const int widths[] = {210, 104, 64};
        for (int i = 0; i < 3; ++i) { LVCOLUMNW column{}; column.mask = LVCF_TEXT | LVCF_WIDTH; column.pszText = const_cast<LPWSTR>(columns[i]); column.cx = S(widths[i]); ListView_InsertColumn(peerList_, i, &column); }
        Label(L"连接管理", 614, 624, 382, 24, 0, 0, 1); widgets_.back().bottom = true;
        connectionHint_ = Label(L"请选择身份并连接私有网络。\r\n私网在线与桥接配对是两个独立状态。", 614, 654, 382, 32, 0, 0, 3, true); widgets_.back().stretch = true; widgets_.back().bottom = true;
        Button(L"暂停配对连接", PAIR_TOGGLE, 614, 692, 382, 32, 0); widgets_.back().stretch = true; widgets_.back().bottom = true;

        Label(L"调用端 · Claude 模型调用", 228, 132, 540, 24, 1, 1, 1);
        Button(L"开启模型 API", MODEL_API_TOGGLE, 784, 128, 208, 30, 1, 1, true);
        Label(L"Base URL · OpenAI 兼容接口", 228, 164, 540, 20, 1, 1, 3, true);
        Edit(DesktopModelApi::BaseUrl(options_.port).c_str(), API_ENDPOINT, 228, 188, 540, 32, 1, 1, false, true, true);
        Button(L"复制 Base URL", COPY_ENDPOINT, 784, 188, 208, 32, 1, 1, true);
        Label(L"API Key · 仅供本机调用，以 Bearer 方式认证", 228, 236, 540, 20, 1, 1, 3, true);
        auto apiToken = Edit(L"", API_TOKEN, 228, 260, 540, 32, 1, 1, false, true, true);
        SendMessageW(apiToken, EM_SETPASSWORDCHAR, L'\x25CF', 0);
        Button(L"复制 API Key", COPY_TOKEN, 784, 260, 208, 32, 1, 1, true);
        Label(L"服务端可用模型 · Model ID", 228, 308, 540, 20, 1, 1, 3, true);
        Add(L"COMBOBOX", L"", API_MODEL, 228, 332, 420, 250, 1, 1, WS_TABSTOP | CBS_DROPDOWNLIST | WS_VSCROLL, 0, false, true);
        Button(L"刷新列表", MODELS_REFRESH, 664, 332, 112, 32, 1, 1, true);
        Button(L"复制 Model ID", COPY_MODEL, 792, 332, 200, 32, 1, 1, true);
        modelStatus_ = Label(L"正在读取 Claude 模型服务状态…", 228, 380, 764, 38, 1, 1, 3, true); widgets_.back().stretch = true;
        Label(L"Claude 调用测试", 228, 470, 500, 24, 1, 1, 1);
        Button(L"复制 PowerShell 示例", COPY_EXAMPLE, 784, 466, 208, 32, 1, 1, true);
        Edit(L"请用一句话说明你能提供什么帮助", TEST_PROMPT, 228, 512, 620, 56, 1, 1, true, false, true);
        Button(L"发送测试", TEST_SEND, 864, 512, 128, 32, 1, 1, true);
        Button(L"取消调用", TEST_CANCEL, 864, 552, 128, 28, 1, 1, true);
        Edit(L"开启模型 API 并连接服务端后可测试；每次测试都是独立请求。", TEST_OUTPUT, 228, 600, 764, 116, 1, 1, true, true, true, true);
        Label(L"服务端 · Claude 服务配置", 228, 132, 540, 24, 1, 2, 1);
        Label(L"Claude 程序路径或命令（claude 自动检测）", 228, 176, 540, 20, 1, 2, 3, true);
        Edit(L"claude", CLAUDE_COMMAND, 228, 204, 540, 30, 1, 2, false, false, true);
        Button(L"检测 Claude", PROBE_CLAUDE, 784, 204, 208, 30, 1, 2, true);
        Label(L"Claude 工作目录", 228, 254, 540, 20, 1, 2, 3, true);
        Edit(L"", WORKSPACE, 228, 282, 540, 30, 1, 2, false, false, true);
        Button(L"选择目录", BROWSE_WORKSPACE, 784, 282, 208, 30, 1, 2, true);
        Label(L"单次最长时间（秒）", 228, 336, 250, 20, 1, 2, 3, true);
        Edit(L"600", MODEL_TIMEOUT, 228, 364, 250, 30, 1, 2);
        Label(L"单次最多推理轮数", 512, 336, 250, 20, 1, 2, 3, true);
        Edit(L"30", MODEL_MAX_TURNS, 512, 364, 250, 30, 1, 2);
        Label(L"先安装并登录 Claude Code，再开启模型服务。\r\n模型请求由已配对的 调用端 发起；网络共享可独立开启或关闭。", 228, 426, 764, 48, 1, 2, 0, true); widgets_.back().stretch = true;
        Button(L"保存配置并开启模型服务", MODEL_ENABLE, 228, 496, 354, 38, 1, 2);
        Button(L"关闭模型服务", MODEL_DISABLE, 600, 496, 240, 38, 1, 2);
        Label(L"服务状态", 228, 572, 700, 24, 1, 2, 1);
        // A 与 B 使用不同控件，角色切换时不会残留另一端的配置或提示。
        hostModelStatus_ = Label(L"尚未开启模型服务。", 228, 608, 764, 52, 1, 2, 0, true); widgets_.back().stretch = true;

        Label(L"本次会话记录", 228, 132, 500, 24, 2, 0, 1);
        Button(L"打开数据目录", OPEN_DATA, 840, 128, 152, 32, 2, 0, true);
        activity_ = Edit(L"等待设备连接，记录会显示在这里。", 0, 228, 180, 764, 484, 2, 0, true, true, true, true);
        Label(L"调用端 · 本地代理节点", 228, 132, 390, 24, 3, 1, 1);
        Label(L"服务端 · 网络共享", 228, 132, 390, 24, 3, 2, 1);
        Button(L"网络测速", NETWORK_SPEED_TEST, 716, 128, 132, 30, 3, 0, true);
        Button(L"网络诊断", NETWORK_DIAGNOSTICS, 860, 128, 132, 30, 3, 0, true);
        proxyMessage_ = Label(L"正在读取代理状态…", 228, 172, 764, 44, 3, 0, 0); widgets_.back().stretch = true;
        proxyDetails_ = Label(L"", 228, 224, 440, 42, 3, 0, 3, true); widgets_.back().stretch = true;
        Button(L"启用本地 Clash 节点", PROXY_ENABLE, 690, 224, 302, 36, 3, 1, true);
        Button(L"开启本机网络共享", PROXY_SHARING, 690, 224, 302, 36, 3, 2, true);
        Label(L"设备与代理连接", 228, 312, 700, 24, 3, 0, 1);
        Label(L"速率为当前代理流量；延迟为 A ↔ B 往返时间。", 228, 344, 764, 22, 3, 0, 3, true); widgets_.back().stretch = true;
        proxyPeerList_ = Add(WC_LISTVIEWW, L"", 0, 228, 380, 764, 184, 3, 0, LVS_REPORT | LVS_SINGLESEL | LVS_NOSORTHEADER, 3, false, true, true);
        ListView_SetExtendedListViewStyle(proxyPeerList_, LVS_EX_FULLROWSELECT | LVS_EX_DOUBLEBUFFER | LVS_EX_LABELTIP);
        const wchar_t* proxyColumns[] = {L"设备 / 身份", L"虚拟 IP", L"代理状态", L"连接 / 已传输", L"实时速率 / 延迟"};
        const int proxyWidths[] = {160, 106, 100, 104, 250};
        for (int i = 0; i < 5; ++i) { LVCOLUMNW column{}; column.mask = LVCF_TEXT | LVCF_WIDTH; column.pszText = const_cast<LPWSTR>(proxyColumns[i]); column.cx = S(proxyWidths[i]); ListView_InsertColumn(proxyPeerList_, i, &column); }
        Label(L"Clash 配置订阅", 228, 612, 580, 24, 3, 1, 1); widgets_.back().bottom = true;
        Edit(L"启用本地节点后生成", PROXY_SUBSCRIPTION, 228, 646, 556, 34, 3, 1, false, true, true); widgets_.back().bottom = true;
        Button(L"复制订阅地址", COPY_SUBSCRIPTION, 800, 646, 192, 34, 3, 1, true); widgets_.back().bottom = true;
        Label(L"导入完整配置并开启 Clash TUN；服务端断开时不回退直连。请保持本客户端运行。", 228, 696, 764, 24, 3, 1, 3, true); widgets_.back().stretch = true; widgets_.back().bottom = true;
        Label(L"共享说明", 228, 612, 580, 24, 3, 2, 1); widgets_.back().bottom = true;
        Label(L"只有已配对的调用端可以使用本机网络出口。\r\n“使用中”表示正在连接网络共享；停止共享不会中断 Claude 模型服务。", 228, 652, 764, 52, 3, 2, 0, true); widgets_.back().stretch = true; widgets_.back().bottom = true;
        Label(L"后台运行", 228, 132, 540, 24, 4, 0, 1);
        Label(L"最小化或关闭窗口会收起到托盘，连接与服务继续运行。\r\n双击托盘图标可恢复窗口；右键选择“退出”才会停止客户端。", 228, 172, 764, 42, 4, 0, 0, true); widgets_.back().stretch = true;
        Button(L"收起到托盘", MINIMIZE_TRAY, 228, 224, 220, 34, 4);
        Label(L"开机启动", 228, 294, 540, 24, 4, 0, 1);
        Add(L"BUTTON", L"Windows 登录后自动在后台运行", STARTUP_ENABLE, 228, 328, 540, 26, 4, 0, BS_AUTOCHECKBOX | WS_TABSTOP);
        startupHint_ = Label(L"", 228, 364, 764, 40, 4, 0, 3, true); widgets_.back().stretch = true;
        auto versionLabel = L"Claude Bridge · v" + Wide(BRIDGE_VERSION);
        if constexpr (BRIDGE_DIAGNOSTICS_BUILD) versionLabel += L" · 本地诊断版";
        Label(versionLabel.c_str(), 228, 458, 540, 24, 4);
        Button(L"开源许可", OPEN_LICENSES, 784, 450, 208, 34, 4, 0, true);
        Label(L"查看本客户端及其所用开源组件的许可与版权说明。", 228, 492, 764, 20, 4, 0, 3, true); widgets_.back().stretch = true;
        if constexpr (BRIDGE_DIAGNOSTICS_BUILD) {
            Label(Wide(BRIDGE_BUILD_LABEL).c_str(), 228, 530, 764, 24, 4, 0, 3, true); widgets_.back().stretch = true;
        }
        LoadSettings(); LoadStartup(); Visibility(); Layout(); UpdateButtons();
    }
    DesktopStartup::Registration Startup() const { return {options_.directory, options_.port, options_.system}; }
    void LoadStartup() {
        EnableWindow(Item(STARTUP_ENABLE), !options_.demo && !BRIDGE_DIAGNOSTICS_BUILD);
        if constexpr (BRIDGE_DIAGNOSTICS_BUILD) {
            Text(startupHint_, L"本地诊断版不修改 Windows 自启动设置。\r\n已保存的正式版设置保持不变。");
            return;
        }
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
        if (options_.demo || BRIDGE_DIAGNOSTICS_BUILD) return;
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
        GetPrivateProfileStringW(L"appearance", L"theme", L"light", buffer, 4096, ini.c_str());
        dark_ = std::wstring_view(buffer) == L"dark"; ApplyTheme();
        settingsLoaded_ = true;
    }
    static LRESULT CALLBACK HeaderProc(HWND header, UINT message, WPARAM wParam, LPARAM lParam, UINT_PTR, DWORD_PTR data) {
        auto self = reinterpret_cast<Application*>(data);
        if (message == WM_PAINT) {
            PAINTSTRUCT ps; auto dc = BeginPaint(header, &ps); RECT client; GetClientRect(header, &client);
            FillRect(dc, &client, self->surface_); SetBkMode(dc, TRANSPARENT); SetTextColor(dc, self->colors_.muted);
            auto oldFont = SelectObject(dc, self->fonts_[3]);
            for (int i = 0; i < Header_GetItemCount(header); ++i) {
                RECT rect; Header_GetItemRect(header, i, &rect); wchar_t text[128]{};
                HDITEMW item{}; item.mask = HDI_TEXT; item.pszText = text; item.cchTextMax = 128;
                Header_GetItem(header, i, &item); rect.left += self->S(5); rect.right -= self->S(4);
                DrawTextW(dc, text, -1, &rect, DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX);
            }
            RECT line{0, client.bottom - 1, client.right, client.bottom}; auto brush = CreateSolidBrush(self->colors_.line);
            FillRect(dc, &line, brush); DeleteObject(brush); SelectObject(dc, oldFont); EndPaint(header, &ps); return 0;
        }
        if (message == WM_ERASEBKGND) return 1;
        return DefSubclassProc(header, message, wParam, lParam);
    }
    void ApplyTheme() {
        colors_ = DesktopTheme::Colors(dark_);
        for (auto brush : {background_, surface_, sidebar_, input_}) if (brush) DeleteObject(brush);
        background_ = CreateSolidBrush(colors_.background); surface_ = CreateSolidBrush(colors_.surface);
        sidebar_ = CreateSolidBrush(colors_.sidebar); input_ = CreateSolidBrush(colors_.input);
        Text(THEME_TOGGLE, dark_ ? L"浅色模式" : L"深色模式");
        DesktopTheme::NativeControls(window_, dark_, true);
        DesktopTheme::TitleBar(window_, dark_, colors_);
        for (const auto& widget : widgets_) {
            DesktopTheme::NativeControls(widget.window, dark_);
            if (widget.edit) SetWindowTheme(widget.window, dark_ ? L"DarkMode_Explorer" : L"Explorer", nullptr);
        }
        // The native checkbox text must follow our palette in both themes.
        SetWindowTheme(Item(STARTUP_ENABLE), L"", L"");
        for (auto list : {peerList_, proxyPeerList_}) if (list) {
            SetWindowTheme(list, L"", L"");
            ListView_SetBkColor(list, colors_.surface); ListView_SetTextBkColor(list, colors_.surface); ListView_SetTextColor(list, colors_.ink);
            auto header = ListView_GetHeader(list);
            SetWindowSubclass(header, HeaderProc, 1, reinterpret_cast<DWORD_PTR>(this));
        }
        if (diagnosticsWindow_) {
            DesktopTheme::TitleBar(diagnosticsWindow_, dark_, colors_);
            SetWindowTheme(diagnosticsOutput_, dark_ ? L"DarkMode_Explorer" : L"Explorer", nullptr);
            RedrawWindow(diagnosticsWindow_, nullptr, nullptr, RDW_INVALIDATE | RDW_ERASE | RDW_FRAME | RDW_ALLCHILDREN);
        }
        if (speedTestWindow_) {
            DesktopTheme::TitleBar(speedTestWindow_, dark_, colors_);
            for (auto child : {speedTestOutput_, speedTestTarget_}) SetWindowTheme(child, dark_ ? L"DarkMode_Explorer" : L"Explorer", nullptr);
            RedrawWindow(speedTestWindow_, nullptr, nullptr, RDW_INVALIDATE | RDW_ERASE | RDW_FRAME | RDW_ALLCHILDREN);
        }
        RedrawWindow(window_, nullptr, nullptr, RDW_INVALIDATE | RDW_ERASE | RDW_FRAME | RDW_ALLCHILDREN);
    }
    void ToggleTheme() {
        dark_ = !dark_; ApplyTheme();
        if (!WritePrivateProfileStringW(L"appearance", L"theme", dark_ ? L"dark" : L"light", (options_.directory / L"desktop.ini").c_str()))
            Message(L"外观已切换，但无法保存；下次启动将使用原来的主题。", true);
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
        HPEN pen = CreatePen(PS_SOLID, 1, colors_.line); auto oldPen = SelectObject(dc, pen); auto oldBrush = SelectObject(dc, surface_);
        MoveToEx(dc, S(184) - 1, 0, nullptr); LineTo(dc, S(184) - 1, client.bottom);
        MoveToEx(dc, S(24), client.bottom - S(140), nullptr); LineTo(dc, S(160), client.bottom - S(140));
        auto card = [&](int x, int y, int w, int h) { RoundRect(dc, S(x), S(y), S(x + w), S(y + h), S(20), S(20)); };
        int extraW = std::max(0, width - 1040), extraH = std::max(0, height - 760);
        if (page_ == 0) { card(208, 112, 808 + extraW, 184); card(208, 312, 370, 424 + extraH); card(594, 312, 422 + extraW, 284 + extraH); card(594, 612 + extraH, 422 + extraW, 124); }
        if (page_ == 1) { if (role_ == 2) card(208, 112, 808 + extraW, 574 + extraH); else { card(208, 112, 808 + extraW, 322); card(208, 450, 808 + extraW, 286 + extraH); } }
        if (page_ == 2) card(208, 112, 808 + extraW, 574 + extraH);
        if (page_ == 3) { card(208, 112, 808 + extraW, 168); card(208, 296, 808 + extraW, 288 + extraH); card(208, 600 + extraH, 808 + extraW, 136); }
        if (page_ == 4) { card(208, 112, 808 + extraW, 160); card(208, 280, 808 + extraW, 136); card(208, 430, 808 + extraW, 86); }
        SelectObject(dc, oldPen); SelectObject(dc, oldBrush); DeleteObject(pen); EndPaint(window_, &ps);
    }
    void DrawButton(DRAWITEMSTRUCT* draw) {
        int id = static_cast<int>(draw->CtlID);
        if (draw->hwndItem == state_) { DrawStatus(draw); return; }
        if (draw->CtlType != ODT_BUTTON) return;
        bool nav = id >= NAV_CONNECTION && id <= NAV_SETTINGS, side = nav || id == THEME_TOGGLE;
        bool selected = (nav && page_ == id - NAV_CONNECTION) || (id == ROLE_CLIENT && role_ == 1) || (id == ROLE_HOST && role_ == 2);
        bool primary = id == PAIR_JOIN || id == PAIR_HOST || id == NETWORK_CONNECT || id == TEST_SEND;
        bool disabled = draw->itemState & ODS_DISABLED;
        const bool hover = hovered_ == draw->hwndItem && !disabled;
        const auto pairingUi = DesktopPairingUi::FromStatus(status_);
        const bool danger = id == PAIR_DISCONNECT || (id == PAIR_JOIN && pairingSummaryShown_) || id == NETWORK_DISCONNECT || id == MODEL_DISABLE || id == TEST_CANCEL;
        const bool pause = id == PAIR_TOGGLE && !pairingUi.resume;
        const bool resume = id == PAIR_TOGGLE && pairingUi.resume;
        COLORREF fill = side ? (selected ? colors_.button : hover ? colors_.hover : colors_.sidebar) : danger ? colors_.redFill : pause ? colors_.yellowFill : resume || selected ? colors_.greenFill : primary ? colors_.primary : hover ? colors_.buttonHover : colors_.button;
        COLORREF edge = side ? fill : danger ? colors_.redLine : pause ? colors_.yellowLine : resume || selected ? colors_.greenLine : primary ? fill : colors_.buttonLine;
        COLORREF ink = side ? selected ? colors_.buttonInk : colors_.ink : danger ? colors_.red : pause ? colors_.yellow : resume || selected ? colors_.green : primary ? colors_.primaryInk : colors_.buttonInk;
        if ((draw->itemState & ODS_SELECTED) && !disabled) fill = colors_.buttonHover;
        if (disabled && !side) { fill = selected ? colors_.greenFill : colors_.disabled; edge = selected ? colors_.greenLine : colors_.buttonLine; ink = selected ? colors_.green : colors_.disabledInk; }
        FillRect(draw->hDC, &draw->rcItem, side ? sidebar_ : surface_);
        HPEN pen = CreatePen(PS_SOLID, 1, edge);
        HBRUSH brush = CreateSolidBrush(fill); auto oldPen = SelectObject(draw->hDC, pen); auto oldBrush = SelectObject(draw->hDC, brush);
        RoundRect(draw->hDC, draw->rcItem.left, draw->rcItem.top, draw->rcItem.right, draw->rcItem.bottom, S(14), S(14));
        SetBkMode(draw->hDC, TRANSPARENT); SetTextColor(draw->hDC, disabled && side ? colors_.disabledInk : ink);
        auto oldFont = SelectObject(draw->hDC, GetParent(draw->hwndItem) == diagnosticsWindow_ ? diagnosticsFont_ : GetParent(draw->hwndItem) == speedTestWindow_ ? speedTestFont_ : selected ? fonts_[1] : fonts_[0]);
        auto text = ControlText(draw->hwndItem); RECT rect = draw->rcItem;
        if (side) {
            const wchar_t* glyph = id == NAV_CONNECTION ? L"\xE968" : id == NAV_API ? L"\xE943" : id == NAV_LOGS ? L"\xE81C" : id == NAV_PROXY ? L"\xE774" : id == NAV_SETTINGS ? L"\xE713" : dark_ ? L"\xE706" : L"\xE708";
            RECT icon = rect; icon.left += S(14); icon.right = icon.left + S(20);
            SelectObject(draw->hDC, iconFont_); DrawTextW(draw->hDC, glyph, -1, &icon, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
            SelectObject(draw->hDC, selected ? fonts_[1] : fonts_[0]); rect.left += S(46); rect.right -= S(8);
        }
        DrawTextW(draw->hDC, text.c_str(), -1, &rect, (side ? DT_LEFT : DT_CENTER) | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX | DT_END_ELLIPSIS);
        if ((draw->itemState & ODS_FOCUS) && !(draw->itemState & ODS_NOFOCUSRECT)) { rect = draw->rcItem; InflateRect(&rect, -S(4), -S(4)); DrawFocusRect(draw->hDC, &rect); }
        SelectObject(draw->hDC, oldFont); SelectObject(draw->hDC, oldPen); SelectObject(draw->hDC, oldBrush); DeleteObject(pen); DeleteObject(brush);
    }
    void DrawStatus(DRAWITEMSTRUCT* draw) {
        const bool green = statusTone_ == DesktopConnectionStatus::Tone::Connected, red = statusTone_ == DesktopConnectionStatus::Tone::Error;
        auto ink = green ? colors_.green : red ? colors_.red : colors_.yellow;
        auto fill = green ? colors_.greenFill : red ? colors_.redFill : colors_.yellowFill;
        auto edge = green ? colors_.greenLine : red ? colors_.redLine : colors_.yellowLine;
        auto dc = draw->hDC; RECT rect = draw->rcItem; FillRect(dc, &rect, background_);
        auto pen = CreatePen(PS_SOLID, 1, edge); auto brush = CreateSolidBrush(fill);
        auto oldPen = SelectObject(dc, pen); auto oldBrush = SelectObject(dc, brush);
        RoundRect(dc, rect.left, rect.top, rect.right, rect.bottom, S(18), S(18));
        auto dot = CreateSolidBrush(ink); SelectObject(dc, dot); SelectObject(dc, GetStockObject(NULL_PEN));
        const int x = rect.left + S(12), y = (rect.top + rect.bottom - S(8)) / 2;
        Ellipse(dc, x, y, x + S(8), y + S(8));
        SelectObject(dc, oldBrush); SelectObject(dc, oldPen); DeleteObject(dot); DeleteObject(brush); DeleteObject(pen);
        auto oldFont = SelectObject(dc, fonts_[3]); SetBkMode(dc, TRANSPARENT); SetTextColor(dc, ink);
        rect.left += S(28); rect.right -= S(13); auto text = ControlText(state_);
        DrawTextW(dc, text.c_str(), -1, &rect, DT_RIGHT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);
        SelectObject(dc, oldFont);
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
        const auto pairingUi = DesktopPairingUi::FromStatus(status_);
        AppendMenuW(menu, MF_STRING | (IsWindowEnabled(Item(PAIR_TOGGLE)) ? 0 : MF_GRAYED), PAIR_TOGGLE, pairingUi.resume ? L"恢复配对连接" : L"暂停配对连接（保留身份）");
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
            occupied = LocalHttpListening(ControlPort());
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
                    auto health = Api(ControlPort(), "", L"/health");
                    if (health.value("service", "") != "claude-p2p-bridge" || health.value("version", "") != BRIDGE_VERSION) throw std::runtime_error("本地端口返回了其他程序的数据");
                    if (health.value("parentPid", DWORD{0}) != GetProcessId(process_.value)) throw std::runtime_error("正在等待本次启动的引擎");
                    auto boot = Api(ControlPort(), "", L"/api/bootstrap"); token_ = boot.at("token").get<std::string>();
                    started = true; ready_ = true; Post({"ready", boot}); break;
                } catch (...) {
                    DWORD exitCode = 1;
                    if (EngineExited(&exitCode)) {
                        // The local API can receive a shutdown request before
                        // this startup poll has finished its first bootstrap.
                        if (exitCode == 0) { PostMessageW(window_, MSG_EXIT, 0, 0); return; }
                        throw std::runtime_error("内置引擎启动失败，请检查本机端口是否被占用，或重新启动客户端");
                    }
                }
                if (WaitForSingleObject(wake_.value, 100) == WAIT_OBJECT_0) return;
            }
            if (!started) { if (!stopping_) throw std::runtime_error("内置引擎启动超时，请检查本机端口是否被占用，或重新启动客户端"); return; }
            int count = 0;
            while (!stopping_) {
                if (EngineExited()) { PostMessageW(window_, MSG_EXIT, 0, 0); return; }
                try { Post({"status", Api(ControlPort(), token_, L"/api/status")}); }
                catch (const std::exception& error) { Post({"poll-error", {}, error.what()}); }
                if (count++ % 3 == 0) {
                    // Refresh network inventory, then render a versioned full
                    // snapshot so an old poll cannot undo an identity change.
                    try { Api(ControlPort(), token_, L"/api/tailscale", nullptr, 5000); Post({"status", Api(ControlPort(), token_, L"/api/status")}); }
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
        const auto pairingUi = DesktopPairingUi::FromStatus(status_);
        EnableWindow(Item(ROLE_CLIENT), enabled && !locked && !testing_);
        EnableWindow(Item(ROLE_HOST), enabled && !locked && !testing_);
        EnableWindow(Item(NETWORK_CONNECT), enabled && !role.empty() && !locked);
        EnableWindow(Item(NETWORK_DISCONNECT), enabled && locked);
        EnableWindow(Item(NETWORK_REFRESH), enabled && locked);
        EnableWindow(Item(NETWORK_LOGIN), enabled && locked && !authUrl_.empty());
        EnableWindow(Item(PAIR_JOIN), enabled && role == "client" && (pairingUi.valid || (networkReady && pairingUi.editable)));
        EnableWindow(Item(PAIR_HOST), enabled && role == "host" && networkReady);
        EnableWindow(Item(PROBE_CLAUDE), enabled && role == "host" && Capability("model"));
        EnableWindow(Item(MODEL_ENABLE), enabled && role == "host" && Capability("model"));
        EnableWindow(Item(MODEL_DISABLE), enabled && role == "host" && Capability("model") && Model().value("enabled", false));
        EnableWindow(Item(MODEL_API_TOGGLE), ready_ && statusAvailable_ && !busy_ &&
            (ModelApi().value("listening", false) || (enabled && Capability("model") && role == "client")));
        EnableWindow(Item(NAV_API), ready_ && (Capability("model") || ModelApi().value("listening", false)));
        EnableWindow(Item(NAV_PROXY), ready_ && Capability("proxy"));
        EnableWindow(Item(NETWORK_DIAGNOSTICS), ready_ && !stopping_);
        EnableWindow(Item(NETWORK_SPEED_TEST), ready_ && statusAvailable_ && !stopping_ && Object(proxy_, "speedTest").value("connected", false));
        EnableWindow(Item(COPY_INVITE), enabled && !invitation_.empty());
        EnableWindow(Item(COPY_TOKEN), ready_ && Capability("model"));
        EnableWindow(Item(COPY_EXAMPLE), ready_ && Capability("model") && ModelsReady());
        EnableWindow(Item(COPY_MODEL), ready_ && Capability("model") && ModelsReady());
        EnableWindow(Item(API_MODEL), enabled && Capability("model") && ModelsReady() && !testing_);
        EnableWindow(Item(MODELS_REFRESH), enabled && Capability("model") && role == "client" && status_.value("online", false) && Model().value("modelsState", "") != "loading");
        bool online = role == "client" && Model().value("online", false) && Model().value("available", false);
        EnableWindow(Item(TEST_SEND), ready_ && !busy_ && ModelApi().value("listening", false) && Capability("model") && online && ModelsReady() && !testing_);
        EnableWindow(Item(TEST_CANCEL), testing_ && !requestId_.empty() && !busy_);
        EnableWindow(Item(PAIR_DISCONNECT), enabled && pairingUi.canForget);
        EnableWindow(Item(INVITATION), !busy_);
        EnableWindow(Item(PAIR_TOGGLE), enabled && pairingUi.canToggle && (!pairingUi.resume || networkReady));
        Text(PAIR_TOGGLE, pairingUi.resume ? L"恢复配对连接" : L"暂停配对连接");
        EnableWindow(Item(PROXY_ENABLE), enabled && proxyAvailable_ && Capability("proxy") && role == "client");
        EnableWindow(Item(PROXY_SHARING), enabled && proxyAvailable_ && Capability("proxy") && role == "host");
        EnableWindow(Item(COPY_SUBSCRIPTION), enabled && proxyAvailable_ && !proxy_.value("subscriptionUrl", "").empty());
    }
    void RenderProxy(const Json& proxy) {
        if (!proxy.is_object()) return;
        proxyAvailable_ = true;
        proxy_ = proxy;
        const auto phase = proxy.value("state", "disabled");
        const bool host = Role() == "host";
        const bool sharing = proxy.value("sharing", false);
        std::wstring state = host ? (sharing ? L"本机网络共享已开启" : L"本机网络共享未开启") : phase == "ready" && proxy.value("online", false) ? L"服务端 出口已连接" : phase == "blocked" ? L"服务端 不可用 · 代理请求已阻断" : phase == "waiting" ? L"等待 服务端 · 自动重连中" : L"代理未启用";
        Text(proxyMessage_, state + L"\r\n" + Wide(proxy.value("message", "")));
        const std::wstring endpoint = host ? L"服务端网络共享" : L"调用端 → 服务端";
        std::wstring connections = std::to_wstring(proxy.value("connections", 0));
        if (proxy.contains("connectionLimit") && proxy["connectionLimit"].is_number_integer() && proxy["connectionLimit"].get<int>() > 0)
            connections += L" / " + std::to_wstring(proxy["connectionLimit"].get<int>());
        else if (proxy.contains("connectionLimit") && proxy["connectionLimit"].is_number_integer() && proxy["connectionLimit"].get<int>() == 0)
            connections += L"（不设数量上限）";
        const auto recovery = proxy.value("recoveryMessage", "");
        Text(proxyDetails_, endpoint + L" · 活跃连接 " + connections + L"\r\n" + (sharing ? L"服务端网络共享已开启" : L"服务端网络共享已关闭") + (recovery.empty() ? L"" : L" · " + Wide(recovery)));
        Text(PROXY_ENABLE, proxy.value("enabled", false) ? L"关闭本地 Clash 节点" : L"启用本地 Clash 节点");
        Text(PROXY_SHARING, proxy.value("sharing", false) ? L"停止共享本机网络" : L"允许已配对的 调用端 使用本机网络");
        auto subscription = proxy.value("subscriptionUrl", "");
        Text(PROXY_SUBSCRIPTION, subscription.empty() ? L"启用本地节点后生成" : Wide(subscription));
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
            const auto roleText = role == "host" ? L"服务端" : role == "client" ? L"调用端" : L"";
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
                if (bytes < 1024) usage << bytes << L" 字节";
                else usage << std::fixed << std::setprecision(1) << (static_cast<double>(bytes) / (bytes < 1024 * 1024 ? 1024.0 : 1024.0 * 1024.0)) << (bytes < 1024 * 1024 ? L" KiB" : L" MiB");
                auto text = usage.str(); ListView_SetItemText(list, row, 3, text.data());
                auto live = DesktopSpeedTest::DeviceLive(device); ListView_SetItemText(list, row, 4, live.data());
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
    std::wstring RenderModels(const Json& model) {
        const auto models = model.contains("models") && model["models"].is_array() ? model["models"] : Json::array();
        const auto serialized = models.dump();
        if (serialized != lastModels_) {
            const auto previous = SelectedModel();
            if (!previous.empty()) selectedModel_ = previous;
            SendMessageW(Item(API_MODEL), CB_RESETCONTENT, 0, 0); modelIds_.clear();
            int selected = 0;
            for (const auto& item : models) {
                if (!item.is_object() || !item.contains("id") || !item["id"].is_string()) continue;
                const auto id = Wide(item["id"].get<std::string>());
                if (id.empty()) continue;
                const auto name = Wide(item.value("name", ""));
                const auto label = !name.empty() && name != id ? name + L" · " + id : id;
                SendMessageW(Item(API_MODEL), CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(label.c_str()));
                if (id == selectedModel_) selected = static_cast<int>(modelIds_.size());
                modelIds_.push_back(id);
            }
            if (modelIds_.empty()) SendMessageW(Item(API_MODEL), CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(L"等待 服务端模型列表"));
            else selectedModel_ = modelIds_[selected];
            SendMessageW(Item(API_MODEL), CB_SETCURSEL, selected, 0); lastModels_ = serialized;
        }
        const auto phase = model.value("modelsState", "unavailable");
        if (Role() == "client" && !status_.value("online", false)) return L"服务端 未连接，模型列表暂不可用；连接后自动更新。";
        if (phase == "loading") return L"正在从 服务端 获取 Claude 模型列表…";
        if (phase == "error") return L"获取模型列表失败：" + Wide(model.value("modelsError", "请刷新重试。"));
        if (phase == "ready") return L"已获取 " + std::to_wstring(modelIds_.size()) + L" 个模型，请在上方选择。";
        const auto error = model.value("modelsError", "");
        return error.empty() ? L"模型列表暂不可用，请开启 服务端 的 Claude 服务后刷新。" : Wide(error);
    }
    void RenderStatus(const Json& status) {
        auto revision = status.value("revision", uint64_t{0});
        if (revision < lastStatusRevision_) return;
        lastStatusRevision_ = revision;
        statusAvailable_ = true;
        status_ = status;
        const auto probeScope = status.value("instanceId", "") + "|" + Role();
        if (!speedTestScope_.empty() && speedTestScope_ != probeScope && speedTestWindow_) DestroyWindow(speedTestWindow_);
        speedTestScope_ = probeScope;
        const auto identity = Identity();
        const auto role = Role();
        bool online = status.value("online", false);
        int connectedClients = status.value("connectedClients", 0);
        const auto badge = DesktopConnectionStatus::FromStatus(status, options_.demo);
        SetStatus(badge.text, badge.tone);
        auto pairing = status.value("pairing", Json::object());
        auto model = Model();
        const auto modelsMessage = RenderModels(model);
        const auto modelApi = ModelApi();
        const bool listening = modelApi.value("listening", false);
        std::wstring apiMessage = listening ? L"模型 API 正在监听 · " + Value(API_ENDPOINT) : L"模型 API 未监听 · 开启后才接受模型调用。";
        if (!modelApi.value("error", "").empty()) apiMessage += L"\r\n" + Wide(modelApi.value("error", ""));
        Text(modelStatus_, apiMessage + L"\r\n" + modelsMessage);
        Text(MODEL_API_TOGGLE, listening || modelApi.value("enabled", false) ? L"关闭模型 API" : L"开启模型 API");
        Text(hostModelStatus_, Wide(model.value("message", "尚未开启 Claude 模型服务。")) + L"\r\n" + modelsMessage);
        Text(MODEL_ENABLE, model.value("enabled", false) ? L"保存配置并更新模型服务" : L"保存配置并开启模型服务");
        Text(identityMessage_, Wide(identity.value("message", RoleLocked() ? "身份已锁定；先退出私有网络才能切换。" : "请选择身份，再连接私有网络。")));
        bool roleChanged = role != observedRole_;
        const auto testScope = DesktopAccess::ModelTestScope(status);
        if (roleChanged || testScope != testScope_) {
            ++viewEpoch_; requestId_.clear(); testScope_ = testScope;
            Text(TEST_OUTPUT, testing_ ? L"连接或授权已改变，本次测试已停止；连接就绪后可重新测试。" : L"每次测试都是独立请求。");
        }
        if (roleChanged) { role_ = role == "host" ? 2 : role == "client" ? 1 : 0; page_ = 0; lastProxyDevices_.clear(); }
        if ((page_ == 1 && !Capability("model") && !listening) || (page_ == 3 && !Capability("proxy"))) page_ = 0;
        observedRole_ = role;
        const auto pairingUi = DesktopPairingUi::FromStatus(status);
        SendMessageW(Item(INVITATION), EM_SETREADONLY, !pairingUi.editable, 0);
        if (pairingUi.valid) Text(INVITATION, pairingUi.detail);
        else if (pairingSummaryShown_ || roleChanged) Text(INVITATION, L"");
        pairingSummaryShown_ = pairingUi.valid;
        Text(pairingCaption_, pairingUi.valid ? L"已保存的配对信息" : pairing.value("state", "") == "invalid" || pairing.value("state", "") == "error" ? L"配对已失效，请粘贴新的服务端配对码" : L"粘贴服务端的配对码");
        Text(PAIR_JOIN, pairingUi.valid ? L"忘记配对" : L"配对并连接服务端");
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
        std::wstring hint = role.empty() ? L"先选择调用端或服务端，再连接私有网络。" : !RoleLocked() ? L"私有网络已退出；可以切换身份。" : L"两端登录同一私有网络后进行桥接配对。\r\n临时掉线不会解除身份锁定。";
        if (pairing.is_object() && (pairing.value("saved", false) || pairing.value("state", "none") == "error")) {
            hint = Wide(pairing.value("message", "")) + L"\r\n" + Wide(DesktopAccess::PairingRecoveryHint(pairing, identity.value("desiredOnline", false)));
        }
        if (role == "host" && online) hint = L"已连接 " + std::to_wstring(connectedClients) + L" 个调用端。\r\n模型服务与网络共享可分别启停。";
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
            try { Post({kind, Api(ControlPort(), token_, route, route == L"/api/tailscale" || (route == L"/api/proxy" && kind == "proxy-copy") ? nullptr : &body, 30000)}); }
            catch (const std::exception& error) { Post({"action-error", {}, error.what()}); }
        });
    }
    void StartTest() {
        if (testing_ || !statusAvailable_ || !ModelApi().value("listening", false) || Role() != "client" || !Capability("model") || !Model().value("available", false) || !ModelsReady()) return;
        auto prompt = Utf8(Value(TEST_PROMPT)); if (prompt.empty()) throw std::runtime_error("请先输入要发送给 Claude 的内容");
        auto model = Utf8(SelectedModel()); if (model.empty()) throw std::runtime_error("请先获取 B 端模型列表并选择模型");
        Json body = {{"model", model}, {"messages", Json::array({{{"role", "user"}, {"content", prompt}}})}, {"stream", true}};
        if (testThread_.joinable()) testThread_.join();
        testing_ = true; requestId_.clear(); Text(TEST_OUTPUT, L"正在调用 服务端 的 Claude…"); UpdateButtons();
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
        if (reply.kind == "speed-test-command" || reply.kind == "speed-test-error") {
            speedTestCommandBusy_ = false;
            speedStatusEpoch_.Settled();
            if (speedTestThread_.joinable()) speedTestThread_.join();
            if (!speedTestWindow_ || !ownedSpeedTests_.Current(reply.viewEpoch)) return;
            if (reply.kind == "speed-test-command") UpdateSpeedTestState(reply.data);
            else Text(speedTestPhase_, L"测速请求未完成，请稍后刷新状态；不会自动重试。\r\n" + Wide(reply.text));
            UpdateSpeedTestControls(); ReadSpeedTestStatus(); return;
        }
        if (reply.kind == "speed-test-status" || reply.kind == "speed-test-status-error") {
            speedStatusBusy_ = false;
            if (speedStatusThread_.joinable()) speedStatusThread_.join();
            if (!speedTestWindow_ || !ownedSpeedTests_.Current(reply.viewEpoch)) return;
            if (!speedStatusEpoch_.Accept(reply.data.value("mutation", uint64_t{0}))) { ReadSpeedTestStatus(); return; }
            if (reply.kind == "speed-test-status") UpdateSpeedTestState(reply.data["status"], reply.data.value("authoritative", false));
            else { speedTestState_["available"] = false; Text(speedTestPhase_, L"暂时无法读取测速状态，请稍后重试。"); }
            UpdateSpeedTestControls(); return;
        }
        if (reply.kind == "diagnostics" || reply.kind == "diagnostics-error") {
            diagnosticsBusy_ = false;
            if (diagnosticsThread_.joinable()) diagnosticsThread_.join();
            if (!diagnosticsWindow_) return;
            if (diagnosticsReadPending_) { diagnosticsReadPending_ = false; ReadNetworkDiagnostics(); return; }
            if (reply.viewEpoch != diagnosticsEpoch_) return;
            const auto diagnostics = reply.kind == "diagnostics" ? reply.data : Json{{"available", false}, {"message", "读取失败：" + reply.text}};
            DWORD selectionStart = 0, selectionEnd = 0;
            SendMessageW(diagnosticsOutput_, EM_GETSEL, reinterpret_cast<WPARAM>(&selectionStart), reinterpret_cast<LPARAM>(&selectionEnd));
            const auto firstLine = SendMessageW(diagnosticsOutput_, EM_GETFIRSTVISIBLELINE, 0, 0);
            Text(diagnosticsOutput_, DesktopNetworkDiagnostics::Format(diagnostics));
            SendMessageW(diagnosticsOutput_, EM_SETSEL, selectionStart, selectionEnd);
            SendMessageW(diagnosticsOutput_, EM_LINESCROLL, 0, firstLine - SendMessageW(diagnosticsOutput_, EM_GETFIRSTVISIBLELINE, 0, 0));
            EnableWindow(diagnosticsRefresh_, ready_ && !stopping_);
            return;
        }
        if (reply.kind == "ready") { Text(API_TOKEN, Wide(token_)); SetStatus(L"服务已就绪 · 正在读取身份", DesktopConnectionStatus::Tone::Waiting); UpdateButtons(); return; }
        if (reply.kind == "startup-error") { SetStatus(L"本机服务启动失败", DesktopConnectionStatus::Tone::Error); Message(Wide(reply.text), true); return; }
        if (reply.kind == "poll-error") {
            SetStatus(L"本机服务暂时不可用", DesktopConnectionStatus::Tone::Error); proxyAvailable_ = false; statusAvailable_ = false;
            Text(modelStatus_, L"本地桥接服务不可用，当前无法读取 服务端 的模型列表。\r\n等待服务恢复后自动更新。");
            Text(proxyMessage_, L"本地桥接服务不可用 · 请检查后台进程。\r\n代理连接状态无法确认，等待服务恢复。");
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
        dialog->SetTitle(L"选择 服务端的 Claude 项目目录");
        if (SUCCEEDED(dialog->Show(window_))) {
            IShellItem* item = nullptr; if (SUCCEEDED(dialog->GetResult(&item))) {
                PWSTR path = nullptr; if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &path))) { Text(WORKSPACE, path); CoTaskMemFree(path); SaveSettings(); }
                item->Release();
            }
        }
        dialog->Release();
    }
    void CancelOwnedSpeedTest(const std::string& id) {
        if (!ownedSpeedTests_.ClaimCancel(id)) return;
        bool success = false;
        try {
            Json body = {{"jobId", id}};
            LocalRequest request(ControlPort(), token_, L"/api/proxy/speed-test/cancel", &body, 2000);
            if (request.status != 404) request.ReadJson();
            success = true; // A missing old ID cannot still own a running job.
        }
        catch (...) { /* The backend deadline remains bounded if a local cancel cannot be delivered. */ }
        ownedSpeedTests_.FinishCancel(id, success);
    }
    void RetireSpeedTestView() {
        const auto owned = ownedSpeedTests_.Retire();
        speedTestView_ = 0;
        if (owned.empty()) return;
        {
            std::lock_guard lock(speedCancelMutex_);
            // Backend single-flight permits only the newest owned job to be
            // live. One pending slot plus one worker bounds both IDs/handles.
            pendingSpeedCancel_ = owned.back();
            if (!speedCancelThread_.joinable()) speedCancelThread_ = std::thread([this] {
                for (;;) {
                    std::string id;
                    {
                        std::unique_lock lock(speedCancelMutex_);
                        speedCancelWake_.wait(lock, [this] { return speedCancelStopping_ || !pendingSpeedCancel_.empty(); });
                        if (speedCancelStopping_) return;
                        id = std::move(pendingSpeedCancel_); pendingSpeedCancel_.clear();
                    }
                    CancelOwnedSpeedTest(id);
                }
            });
        }
        speedCancelWake_.notify_one();
    }
    void UpdateSpeedTestControls() {
        if (!speedTestWindow_) return;
        const bool active = DesktopSpeedTest::Running(speedTestState_);
        const bool enabled = ready_ && !stopping_ && !speedTestCommandBusy_;
        const auto selected = SendMessageW(speedTestTarget_, CB_GETCURSEL, 0, 0);
        const bool supported = selected >= 0 && static_cast<size_t>(selected) < speedTestSupported_.size() && speedTestSupported_[selected];
        EnableWindow(speedTestTarget_, enabled && Role() == "host" && !active && !speedTestTargets_.empty());
        const auto selectedId = supported ? speedTestTargets_[selected] : std::string{};
        EnableWindow(speedTestStart_, enabled && !speedStatusBusy_ && DesktopSpeedTest::CanStartTarget(speedTestState_, selectedId));
        EnableWindow(speedTestCancel_, enabled && active && !DesktopSpeedTest::Text(DesktopSpeedTest::Job(speedTestState_), "id").empty());
        EnableWindow(speedTestExport_, !stopping_ && !active && speedTestReport_.is_object());
    }
    void UpdateSpeedTestState(const Json& response, bool authoritative = false) {
        if (!speedTestWindow_ || !response.is_object()) return;
        const auto previousJobId = DesktopSpeedTest::Text(DesktopSpeedTest::Job(speedTestState_), "id");
        if (response.contains("targets")) speedTestState_ = response;
        else if (const auto job = DesktopSpeedTest::Job(response); !job.empty()) {
            speedTestState_["job"] = job; speedTestState_["busy"] = DesktopSpeedTest::Text(job, "state") == "running";
        }
        const auto targets = DesktopSpeedTest::Targets(speedTestState_);
        const auto serialized = Json(targets).dump();
        if (serialized != lastSpeedTestTargets_) {
            const auto previous = SendMessageW(speedTestTarget_, CB_GETCURSEL, 0, 0);
            const auto selectedId = previous >= 0 && static_cast<size_t>(previous) < speedTestTargets_.size() ? speedTestTargets_[previous] : std::string{};
            SendMessageW(speedTestTarget_, CB_RESETCONTENT, 0, 0); speedTestTargets_.clear(); speedTestSupported_.clear();
            int selection = Role() == "host" ? -1 : 0;
            for (const auto& target : targets) {
                const auto id = DesktopSpeedTest::Text(target, "id");
                const auto name = DesktopSpeedTest::Text(target, "name", 256), address = DesktopSpeedTest::Text(target, "address", 64);
                const bool supported = target["supported"] == true;
                const auto label = (DesktopSpeedTest::Text(target, "role") == "host" ? std::wstring(L"固定 B 服务端 · ") : L"A 调用端 · ") +
                    Wide(name.empty() ? address : name + (address.empty() ? "" : " · " + address)) + (supported ? L"" : L"（需升级 1.2.0）");
                SendMessageW(speedTestTarget_, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(label.c_str()));
                if (id == selectedId) selection = static_cast<int>(speedTestTargets_.size());
                speedTestTargets_.push_back(id);
                speedTestSupported_.push_back(supported);
            }
            if (targets.empty()) { SendMessageW(speedTestTarget_, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(L"没有当前已连接的配对设备")); selection = 0; }
            SendMessageW(speedTestTarget_, CB_SETCURSEL, selection, 0); lastSpeedTestTargets_ = serialized;
        }
        const auto job = DesktopSpeedTest::Job(speedTestState_);
        if (DesktopSpeedTest::Text(job, "id") != previousJobId) speedTestReport_ = Json();
        // Reads started during a POST may describe the pre-start job. They
        // must not erase a newly registered late start's cancellation owner.
        if (authoritative) ownedSpeedTests_.ObserveOnly(DesktopSpeedTest::Text(job, "id"));
        if (job.contains("report")) {
            const auto report = DesktopSpeedTest::Report(job["report"]);
            if (report.is_object()) speedTestReport_ = report;
        }
        if (!job.empty() && !DesktopSpeedTest::Running(speedTestState_)) ownedSpeedTests_.Forget(DesktopSpeedTest::Text(job, "id"));
        RenderSpeedTest();
        UpdateSpeedTestControls();
    }
    void SpeedTestCommand(bool cancel) {
        if (!speedTestWindow_ || !ready_ || stopping_ || speedTestCommandBusy_) return;
        std::string id;
        if (cancel) {
            if (!DesktopSpeedTest::Running(speedTestState_)) return;
            id = DesktopSpeedTest::Text(DesktopSpeedTest::Job(speedTestState_), "id");
        } else {
            if (speedStatusBusy_ || !DesktopSpeedTest::CanStart(speedTestState_)) return;
            const auto selected = SendMessageW(speedTestTarget_, CB_GETCURSEL, 0, 0);
            if (selected < 0 || static_cast<size_t>(selected) >= speedTestTargets_.size() || !speedTestSupported_[selected]) return;
            id = speedTestTargets_[selected];
            if (!DesktopSpeedTest::CanStartTarget(speedTestState_, id)) return;
            speedTestReport_ = Json(); speedTestState_.erase("job"); RenderSpeedTest();
        }
        if (id.empty()) return;
        if (speedTestThread_.joinable()) speedTestThread_.join();
        speedTestCommandBusy_ = true; speedStatusEpoch_.Started(); UpdateSpeedTestControls();
        Text(speedTestPhase_, cancel ? L"正在取消本次测速…" : L"正在提交 A ↔ B 通道测速…");
        const auto epoch = speedTestView_;
        try {
            speedTestThread_ = std::thread([this, cancel, id, epoch] {
                try {
                    Json body = {{cancel ? "jobId" : "targetId", id}};
                    const auto route = cancel ? L"/api/proxy/speed-test/cancel" : L"/api/proxy/speed-test";
                    const auto response = Api(ControlPort(), token_, route, &body, 3000);
                    const auto createdId = cancel ? std::string{} : DesktopSpeedTest::Text(DesktopSpeedTest::Job(response), "id");
                    if (!createdId.empty() && ownedSpeedTests_.Register(createdId, epoch)) CancelOwnedSpeedTest(createdId);
                    if (cancel) ownedSpeedTests_.Forget(id);
                    Post({"speed-test-command", response, {}, {}, epoch});
                } catch (const std::exception& error) { Post({"speed-test-error", {}, error.what(), {}, epoch}); }
            });
        } catch (...) { speedTestCommandBusy_ = false; UpdateSpeedTestControls(); throw; }
    }
    void ExportSpeedTestReport() {
        if (!speedTestWindow_ || !speedTestReport_.is_object() || DesktopSpeedTest::Running(speedTestState_)) return;
        const auto payload = speedTestReport_.dump(2) + "\n";
        IFileSaveDialog* raw = nullptr;
        if (FAILED(CoCreateInstance(CLSID_FileSaveDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&raw)))) throw std::runtime_error("无法创建报告保存窗口");
        std::unique_ptr<IFileSaveDialog, void(*)(IFileSaveDialog*)> dialog(raw, [](IFileSaveDialog* item) { item->Release(); });
        const COMDLG_FILTERSPEC types[] = {{L"JSON 测速报告", L"*.json"}};
        dialog->SetFileTypes(1, types); dialog->SetDefaultExtension(L"json"); dialog->SetTitle(L"导出通道测速报告");
        FILEOPENDIALOGOPTIONS options = 0;
        if (SUCCEEDED(dialog->GetOptions(&options))) dialog->SetOptions(options | FOS_FORCEFILESYSTEM | FOS_OVERWRITEPROMPT | FOS_NOREADONLYRETURN);
        SYSTEMTIME utc{}; GetSystemTime(&utc); wchar_t filename[96];
        swprintf_s(filename, 96, L"Bridge-speed-test-%04u%02u%02u-%02u%02u%02u.json", utc.wYear, utc.wMonth, utc.wDay, utc.wHour, utc.wMinute, utc.wSecond);
        dialog->SetFileName(filename);
        const auto shown = dialog->Show(speedTestWindow_);
        if (shown == HRESULT_FROM_WIN32(ERROR_CANCELLED)) return;
        if (FAILED(shown)) throw std::runtime_error("无法选择报告保存位置");
        IShellItem* item = nullptr; if (FAILED(dialog->GetResult(&item))) throw std::runtime_error("无法读取报告保存位置");
        PWSTR chosen = nullptr; const auto location = item->GetDisplayName(SIGDN_FILESYSPATH, &chosen); item->Release();
        if (FAILED(location) || !chosen) throw std::runtime_error("报告必须保存到本地文件");
        const fs::path target(chosen); CoTaskMemFree(chosen);
        // Freeze the whitelisted report before writing; no status or target metadata.
        std::ofstream file(target, std::ios::binary | std::ios::trunc);
        if (!file || !file.write(payload.data(), static_cast<std::streamsize>(payload.size())) || !file.flush()) throw std::runtime_error("报告保存失败");
        Text(speedTestOutput_, DesktopSpeedTest::Details(speedTestState_, speedTestReport_) + L"\r\n\r\nJSON 测速报告已导出。");
    }
    void RenderSpeedTest() {
        if (!speedTestWindow_) return;
        const auto download = DesktopSpeedTest::Speed(speedTestState_, speedTestReport_, "download");
        const auto upload = DesktopSpeedTest::Speed(speedTestState_, speedTestReport_, "upload");
        Text(speedTestDownload_, DesktopSpeedTest::Rate(download)); Text(speedTestDownloadSecondary_, DesktopSpeedTest::Rate(download, false));
        Text(speedTestUpload_, DesktopSpeedTest::Rate(upload)); Text(speedTestUploadSecondary_, DesktopSpeedTest::Rate(upload, false));
        Text(speedTestLatency_, DesktopSpeedTest::Milliseconds(DesktopSpeedTest::Latency(speedTestState_, speedTestReport_)));
        Text(speedTestSamples_, DesktopSpeedTest::SamplesLabel(speedTestState_, speedTestReport_));
        const auto progress = DesktopSpeedTest::ViewProgress(speedTestState_);
        auto style = GetWindowLongPtrW(speedTestProgress_, GWL_STYLE);
        if (progress.marquee) style |= PBS_MARQUEE; else style &= ~static_cast<LONG_PTR>(PBS_MARQUEE);
        if (style != GetWindowLongPtrW(speedTestProgress_, GWL_STYLE)) {
            SetWindowLongPtrW(speedTestProgress_, GWL_STYLE, style);
            SendMessageW(speedTestProgress_, PBM_SETMARQUEE, progress.marquee ? TRUE : FALSE, 50);
        }
        if (!progress.marquee) SendMessageW(speedTestProgress_, PBM_SETPOS, progress.position, 0);
        Text(speedTestPhase_, progress.text);
        const auto selected = SendMessageW(speedTestTarget_, CB_GETCURSEL, 0, 0);
        if (!DesktopSpeedTest::Running(speedTestState_) && selected >= 0 && static_cast<size_t>(selected) < speedTestSupported_.size() && !speedTestSupported_[selected])
            Text(speedTestPhase_, L"所选设备需升级至 1.2.0；双方均升级后才能开始测速。");
        Text(speedTestOutput_, DesktopSpeedTest::Details(speedTestState_, speedTestReport_));
    }
    void ReadSpeedTestStatus() {
        if (!speedTestWindow_ || !ready_ || stopping_ || speedStatusBusy_) return;
        if (speedStatusThread_.joinable()) speedStatusThread_.join();
        speedStatusBusy_ = true; speedLastPoll_ = GetTickCount64(); UpdateSpeedTestControls();
        const auto epoch = speedTestView_, mutation = speedStatusEpoch_.Capture(); const bool authoritative = !speedTestCommandBusy_;
        try {
            speedStatusThread_ = std::thread([this, epoch, mutation, authoritative] {
                try { Post({"speed-test-status", {{"status", Api(ControlPort(), token_, L"/api/proxy/speed-test", nullptr, 3000)}, {"authoritative", authoritative}, {"mutation", mutation}}, {}, {}, epoch}); }
                catch (const std::exception& error) { Post({"speed-test-status-error", {{"mutation", mutation}}, error.what(), {}, epoch}); }
            });
        } catch (...) { speedStatusBusy_ = false; UpdateSpeedTestControls(); throw; }
    }
    void SpeedTestFont() {
        const auto dpi = GetDpiForWindow(speedTestWindow_);
        auto create = [dpi](int size, int weight) { return CreateFontW(-MulDiv(size, dpi, 96), 0, 0, 0, weight, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
            OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Microsoft YaHei UI"); };
        const auto font = create(14, FW_NORMAL), valueFont = create(22, FW_SEMIBOLD);
        if (!font || !valueFont) { if (font) DeleteObject(font); if (valueFont) DeleteObject(valueFont); throw std::runtime_error("无法创建测速窗口字体"); }
        for (auto child : {speedTestTarget_, speedTestStart_, speedTestCancel_, speedTestExport_, speedTestClose_, speedTestOutput_,
                speedTestDownloadSecondary_, speedTestUploadSecondary_, speedTestSamples_, speedTestPhase_, speedTestLabels_[0], speedTestLabels_[1], speedTestLabels_[2]})
            SendMessageW(child, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
        for (auto child : {speedTestDownload_, speedTestUpload_, speedTestLatency_}) SendMessageW(child, WM_SETFONT, reinterpret_cast<WPARAM>(valueFont), TRUE);
        if (speedTestFont_) DeleteObject(speedTestFont_);
        if (speedTestValueFont_) DeleteObject(speedTestValueFont_);
        speedTestFont_ = font; speedTestValueFont_ = valueFont;
    }
    void LayoutSpeedTest() {
        if (!speedTestWindow_) return;
        RECT rect; GetClientRect(speedTestWindow_, &rect); const auto dpi = GetDpiForWindow(speedTestWindow_);
        auto scale = [dpi](int value) { return MulDiv(value, dpi, 96); };
        const int margin = scale(18), gap = scale(12), width = std::max(0, static_cast<int>(rect.right) - margin * 2), buttonH = scale(34);
        MoveWindow(speedTestTarget_, margin, margin, width, scale(220), TRUE);
        const int column = std::max(0, (width - gap * 2) / 3);
        const HWND values[] = {speedTestDownload_, speedTestUpload_, speedTestLatency_}, secondary[] = {speedTestDownloadSecondary_, speedTestUploadSecondary_, speedTestSamples_};
        for (int i = 0; i < 3; ++i) {
            const int x = margin + i * (column + gap);
            MoveWindow(speedTestLabels_[i], x, scale(76), column, scale(22), TRUE);
            MoveWindow(values[i], x, scale(108), column, scale(40), TRUE);
            MoveWindow(secondary[i], x, scale(154), column, scale(42), TRUE);
        }
        MoveWindow(speedTestProgress_, margin, scale(208), width, scale(14), TRUE);
        MoveWindow(speedTestPhase_, margin, scale(236), width, scale(48), TRUE);
        const int footer = rect.bottom - margin - buttonH, detailsTop = scale(296);
        MoveWindow(speedTestOutput_, margin, detailsTop, width, std::max(scale(40), footer - detailsTop - gap), TRUE);
        const int buttonW = (width - gap * 3) / 4;
        const HWND buttons[] = {speedTestStart_, speedTestCancel_, speedTestExport_, speedTestClose_};
        for (int i = 0; i < 4; ++i) MoveWindow(buttons[i], margin + i * (buttonW + gap), footer, buttonW, buttonH, TRUE);
    }
    LRESULT HandleSpeedTest(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
        switch (message) {
        case WM_CREATE: {
            auto control = [this, window](const wchar_t* type, const wchar_t* text, int id, DWORD style) {
                const auto child = CreateWindowExW(0, type, text, WS_CHILD | WS_VISIBLE | style, 0, 0, 0, 0, window, reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)), instance_, nullptr);
                if (!child) throw std::runtime_error("无法创建测速窗口控件");
                SetWindowSubclass(child, ControlProc, 1, reinterpret_cast<DWORD_PTR>(this)); DesktopTheme::NativeControls(child, dark_); return child;
            };
            speedTestTarget_ = control(L"COMBOBOX", L"", SPEED_TEST_TARGET, WS_TABSTOP | WS_VSCROLL | CBS_DROPDOWNLIST);
            SendMessageW(speedTestTarget_, CB_SETCUEBANNER, 0, reinterpret_cast<LPARAM>(L"请选择要测速的在线 A 调用端"));
            speedTestStart_ = control(L"BUTTON", L"开始测速", SPEED_TEST_START, WS_TABSTOP | BS_OWNERDRAW);
            speedTestCancel_ = control(L"BUTTON", L"取消测速", SPEED_TEST_CANCEL, WS_TABSTOP | BS_OWNERDRAW);
            speedTestExport_ = control(L"BUTTON", L"导出 JSON", SPEED_TEST_EXPORT, WS_TABSTOP | BS_OWNERDRAW);
            speedTestClose_ = control(L"BUTTON", L"关闭", SPEED_TEST_CLOSE, WS_TABSTOP | BS_OWNERDRAW);
            speedTestDownload_ = control(L"STATIC", L"—", SPEED_TEST_DOWNLOAD, SS_NOPREFIX);
            speedTestUpload_ = control(L"STATIC", L"—", SPEED_TEST_UPLOAD, SS_NOPREFIX);
            speedTestLatency_ = control(L"STATIC", L"—", SPEED_TEST_LATENCY, SS_NOPREFIX);
            speedTestDownloadSecondary_ = control(L"STATIC", L"—", SPEED_TEST_DOWNLOAD_SECONDARY, SS_NOPREFIX);
            speedTestUploadSecondary_ = control(L"STATIC", L"—", SPEED_TEST_UPLOAD_SECONDARY, SS_NOPREFIX);
            speedTestSamples_ = control(L"STATIC", L"传输中 RTT · 中位数", SPEED_TEST_SAMPLES, SS_NOPREFIX);
            speedTestLabels_[0] = control(L"STATIC", L"A 下载 · B → A", 0, SS_NOPREFIX);
            speedTestLabels_[1] = control(L"STATIC", L"A 上传 · A → B", 0, SS_NOPREFIX);
            speedTestLabels_[2] = control(L"STATIC", L"延迟 RTT", 0, SS_NOPREFIX);
            speedTestProgress_ = control(PROGRESS_CLASSW, L"", SPEED_TEST_PROGRESS, PBS_SMOOTH);
            SendMessageW(speedTestProgress_, PBM_SETRANGE32, 0, 1000);
            speedTestPhase_ = control(L"STATIC", L"正在读取已配对连接…", SPEED_TEST_PHASE, SS_NOPREFIX);
            speedTestOutput_ = control(L"EDIT", L"", SPEED_TEST_DETAILS, WS_BORDER | WS_TABSTOP | ES_MULTILINE | ES_AUTOVSCROLL | ES_READONLY | WS_VSCROLL);
            SendMessageW(speedTestOutput_, EM_SETLIMITTEXT, 256 * 1024, 0);
            DesktopTheme::TitleBar(window, dark_, colors_);
            speedTestView_ = ownedSpeedTests_.BeginView(); speedTestState_ = Json::object(); speedTestReport_ = Json();
            speedTestTargets_.clear(); speedTestSupported_.clear(); lastSpeedTestTargets_.clear(); speedLastPoll_ = 0;
            SpeedTestFont(); LayoutSpeedTest(); RenderSpeedTest(); UpdateSpeedTestControls(); return 0;
        }
        case WM_COMMAND:
            if (LOWORD(wParam) == SPEED_TEST_TARGET && HIWORD(wParam) == CBN_SELCHANGE) { RenderSpeedTest(); UpdateSpeedTestControls(); }
            else if (LOWORD(wParam) == SPEED_TEST_START && HIWORD(wParam) == BN_CLICKED) SpeedTestCommand(false);
            else if (LOWORD(wParam) == SPEED_TEST_CANCEL && HIWORD(wParam) == BN_CLICKED) SpeedTestCommand(true);
            else if (LOWORD(wParam) == SPEED_TEST_EXPORT && HIWORD(wParam) == BN_CLICKED) ExportSpeedTestReport();
            else if (LOWORD(wParam) == SPEED_TEST_CLOSE || LOWORD(wParam) == IDCANCEL) DestroyWindow(window);
            return 0;
        case WM_TIMER:
            if (wParam == SPEED_TEST_TIMER && GetTickCount64() - speedLastPoll_ >= (DesktopSpeedTest::Running(speedTestState_) ? 500 : 1500)) ReadSpeedTestStatus();
            return 0;
        case WM_CLOSE: DestroyWindow(window); return 0;
        case WM_SIZE: LayoutSpeedTest(); return 0;
        case WM_DPICHANGED: {
            const auto rect = reinterpret_cast<RECT*>(lParam);
            SetWindowPos(window, nullptr, rect->left, rect->top, rect->right - rect->left, rect->bottom - rect->top, SWP_NOZORDER | SWP_NOACTIVATE);
            SpeedTestFont(); LayoutSpeedTest(); return 0;
        }
        case WM_GETMINMAXINFO: {
            const auto dpi = GetDpiForWindow(window); RECT rect{0, 0, MulDiv(620, dpi, 96), MulDiv(440, dpi, 96)};
            AdjustWindowRectExForDpi(&rect, WS_OVERLAPPEDWINDOW, FALSE, WS_EX_TOOLWINDOW | WS_EX_CONTROLPARENT, dpi);
            reinterpret_cast<MINMAXINFO*>(lParam)->ptMinTrackSize = {rect.right - rect.left, rect.bottom - rect.top}; return 0;
        }
        case WM_DRAWITEM: DrawButton(reinterpret_cast<DRAWITEMSTRUCT*>(lParam)); return TRUE;
        case WM_ERASEBKGND: { RECT rect; GetClientRect(window, &rect); FillRect(reinterpret_cast<HDC>(wParam), &rect, surface_); return 1; }
        case WM_CTLCOLORSTATIC: case WM_CTLCOLOREDIT: case WM_CTLCOLORLISTBOX: {
            const bool input = reinterpret_cast<HWND>(lParam) == speedTestOutput_ || message == WM_CTLCOLORLISTBOX;
            SetTextColor(reinterpret_cast<HDC>(wParam), colors_.ink); SetBkColor(reinterpret_cast<HDC>(wParam), input ? colors_.input : colors_.surface);
            return reinterpret_cast<LRESULT>(input ? input_ : surface_);
        }
        case WM_DESTROY:
            KillTimer(window, SPEED_TEST_TIMER); RetireSpeedTestView(); speedTestWindow_ = nullptr;
            speedTestTarget_ = speedTestStart_ = speedTestCancel_ = speedTestExport_ = speedTestOutput_ = speedTestClose_ = nullptr;
            speedTestDownload_ = speedTestDownloadSecondary_ = speedTestUpload_ = speedTestUploadSecondary_ = nullptr;
            speedTestLatency_ = speedTestSamples_ = speedTestProgress_ = speedTestPhase_ = nullptr;
            for (auto& label : speedTestLabels_) label = nullptr;
            speedTestState_ = Json::object(); speedTestReport_ = Json(); speedTestTargets_.clear(); speedTestSupported_.clear(); lastSpeedTestTargets_.clear();
            if (speedTestFont_) { DeleteObject(speedTestFont_); speedTestFont_ = nullptr; }
            if (speedTestValueFont_) { DeleteObject(speedTestValueFont_); speedTestValueFont_ = nullptr; }
            return 0;
        }
        return DefWindowProcW(window, message, wParam, lParam);
    }
    static LRESULT CALLBACK SpeedTestWindowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
        auto self = reinterpret_cast<Application*>(GetWindowLongPtrW(window, GWLP_USERDATA));
        if (message == WM_NCCREATE) { self = static_cast<Application*>(reinterpret_cast<CREATESTRUCTW*>(lParam)->lpCreateParams); self->speedTestWindow_ = window; SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self)); }
        if (!self) return DefWindowProcW(window, message, wParam, lParam);
        try { return self->HandleSpeedTest(window, message, wParam, lParam); }
        catch (const std::exception& error) { if (self->speedTestPhase_) self->Text(self->speedTestPhase_, L"测速暂不可用：" + Wide(error.what())); return message == WM_CREATE ? -1 : 0; }
    }
    void OpenSpeedTest() {
        if (!ready_ || stopping_ || !Object(proxy_, "speedTest").value("connected", false)) return;
        if (speedTestWindow_) { ShowWindow(speedTestWindow_, SW_RESTORE); SetForegroundWindow(speedTestWindow_); return; }
        const auto name = className_ + L".SpeedTest";
        WNDCLASSEXW type{}; type.cbSize = sizeof(type);
        if (!GetClassInfoExW(instance_, name.c_str(), &type)) {
            type.hInstance = instance_; type.lpfnWndProc = SpeedTestWindowProc; type.lpszClassName = name.c_str(); type.hCursor = LoadCursorW(nullptr, IDC_ARROW);
            type.hIcon = LoadIconW(instance_, MAKEINTRESOURCEW(101)); type.hIconSm = type.hIcon;
            if (!RegisterClassExW(&type)) throw std::runtime_error("无法注册测速窗口");
        }
        RECT owner; GetWindowRect(window_, &owner); RECT rect{0, 0, S(680), S(500)};
        const DWORD extra = WS_EX_TOOLWINDOW | WS_EX_CONTROLPARENT;
        AdjustWindowRectExForDpi(&rect, WS_OVERLAPPEDWINDOW, FALSE, extra, dpi_);
        MONITORINFO monitor{sizeof(monitor)}; GetMonitorInfoW(MonitorFromWindow(window_, MONITOR_DEFAULTTONEAREST), &monitor);
        const int width = std::min(rect.right - rect.left, monitor.rcWork.right - monitor.rcWork.left), height = std::min(rect.bottom - rect.top, monitor.rcWork.bottom - monitor.rcWork.top);
        const int x = std::clamp(owner.left + (owner.right - owner.left - width) / 2, monitor.rcWork.left, monitor.rcWork.right - width);
        const int y = std::clamp(owner.top + (owner.bottom - owner.top - height) / 2, monitor.rcWork.top, monitor.rcWork.bottom - height);
        if (!CreateWindowExW(extra, name.c_str(), L"网络测速 · A ↔ B", WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN, x, y, width, height, window_, nullptr, instance_, this)) throw std::runtime_error("无法创建测速窗口");
        if (!SetTimer(speedTestWindow_, SPEED_TEST_TIMER, 500, nullptr)) { DestroyWindow(speedTestWindow_); throw std::runtime_error("无法启动测速状态刷新"); }
        ShowWindow(speedTestWindow_, SW_SHOWNORMAL); ReadSpeedTestStatus();
    }
    void DiagnosticsFont() {
        const auto dpi = GetDpiForWindow(diagnosticsWindow_);
        auto font = CreateFontW(-MulDiv(14, dpi, 96), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
            DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Microsoft YaHei UI");
        if (!font) throw std::runtime_error(WindowsError("创建诊断窗口字体"));
        for (auto child : {diagnosticsOutput_, diagnosticsRefresh_, diagnosticsClose_}) SendMessageW(child, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
        if (diagnosticsFont_) DeleteObject(diagnosticsFont_);
        diagnosticsFont_ = font;
    }
    void LayoutDiagnostics() {
        if (!diagnosticsWindow_) return;
        RECT rect; GetClientRect(diagnosticsWindow_, &rect);
        const auto dpi = GetDpiForWindow(diagnosticsWindow_);
        auto scale = [dpi](int value) { return MulDiv(value, dpi, 96); };
        const int margin = scale(18), buttonW = scale(104), buttonH = scale(32), gap = scale(12);
        const int footer = rect.bottom - margin - buttonH;
        MoveWindow(diagnosticsOutput_, margin, margin, std::max(0, static_cast<int>(rect.right) - margin * 2), std::max(0, footer - margin - gap), TRUE);
        MoveWindow(diagnosticsRefresh_, std::max(margin, static_cast<int>(rect.right) - margin - buttonW * 2 - gap), footer, buttonW, buttonH, TRUE);
        MoveWindow(diagnosticsClose_, std::max(margin, static_cast<int>(rect.right) - margin - buttonW), footer, buttonW, buttonH, TRUE);
    }
    void ReadNetworkDiagnostics(bool automatic = false) {
        if (!diagnosticsWindow_ || stopping_) return;
        if (diagnosticsBusy_) {
            if (automatic) return;
            diagnosticsReadPending_ = true;
            Text(diagnosticsOutput_, L"正在等待前次读取结束，再获取本次诊断采样…");
            EnableWindow(diagnosticsRefresh_, FALSE);
            return;
        }
        if (!ready_) {
            Text(diagnosticsOutput_, DesktopNetworkDiagnostics::Format({{"available", false}, {"message", "本地服务尚未就绪，请稍后手动刷新。"}}));
            return;
        }
        if (diagnosticsThread_.joinable()) diagnosticsThread_.join();
        const auto epoch = ++diagnosticsEpoch_;
        diagnosticsBusy_ = true; EnableWindow(diagnosticsRefresh_, FALSE);
        if (!automatic) Text(diagnosticsOutput_, L"正在读取本机节点网络诊断…\r\n窗口打开期间每 2 秒自动刷新，仅读取已有计数，不发起测速。\r\n\r\n本机节点启动以来累计，包含模型和代理；重传不等于公网丢包率。");
        try {
            diagnosticsThread_ = std::thread([this, epoch] {
                try { Post({"diagnostics", Api(ControlPort(), token_, L"/api/network/diagnostics", nullptr, 5000), {}, {}, epoch}); }
                catch (const std::exception& error) { Post({"diagnostics-error", {}, error.what(), {}, epoch}); }
            });
        } catch (const std::exception& error) {
            diagnosticsBusy_ = false; EnableWindow(diagnosticsRefresh_, TRUE);
            Text(diagnosticsOutput_, DesktopNetworkDiagnostics::Format({{"available", false}, {"message", "读取失败：" + std::string(error.what())}}));
        }
    }
    LRESULT HandleDiagnostics(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
        switch (message) {
        case WM_CREATE: {
            diagnosticsOutput_ = CreateWindowExW(0, L"EDIT", L"", WS_CHILD | WS_VISIBLE | WS_BORDER | WS_TABSTOP | ES_MULTILINE | ES_AUTOVSCROLL | ES_READONLY | WS_VSCROLL,
                0, 0, 0, 0, window, reinterpret_cast<HMENU>(DIAGNOSTICS_OUTPUT), instance_, nullptr);
            diagnosticsRefresh_ = CreateWindowExW(0, L"BUTTON", L"刷新", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_OWNERDRAW,
                0, 0, 0, 0, window, reinterpret_cast<HMENU>(DIAGNOSTICS_REFRESH), instance_, nullptr);
            diagnosticsClose_ = CreateWindowExW(0, L"BUTTON", L"关闭", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_OWNERDRAW,
                0, 0, 0, 0, window, reinterpret_cast<HMENU>(DIAGNOSTICS_CLOSE), instance_, nullptr);
            if (!diagnosticsOutput_ || !diagnosticsRefresh_ || !diagnosticsClose_) throw std::runtime_error(WindowsError("创建诊断窗口控件"));
            for (auto child : {diagnosticsOutput_, diagnosticsRefresh_, diagnosticsClose_}) {
                SetWindowSubclass(child, ControlProc, 1, reinterpret_cast<DWORD_PTR>(this));
                DesktopTheme::NativeControls(child, dark_);
            }
            DesktopTheme::TitleBar(window, dark_, colors_);
            SetWindowTheme(diagnosticsOutput_, dark_ ? L"DarkMode_Explorer" : L"Explorer", nullptr);
            SendMessageW(diagnosticsOutput_, EM_SETLIMITTEXT, 2 * 1024 * 1024, 0);
            DiagnosticsFont(); LayoutDiagnostics(); return 0;
        }
        case WM_COMMAND:
            if (LOWORD(wParam) == DIAGNOSTICS_REFRESH && HIWORD(wParam) == BN_CLICKED) ReadNetworkDiagnostics();
            else if (LOWORD(wParam) == DIAGNOSTICS_CLOSE || LOWORD(wParam) == IDCANCEL) DestroyWindow(window);
            return 0;
        case WM_CLOSE: DestroyWindow(window); return 0;
        case WM_TIMER:
            if (wParam == DIAGNOSTICS_TIMER && !diagnosticsBusy_ && !stopping_) ReadNetworkDiagnostics(true);
            return 0;
        case WM_SIZE: LayoutDiagnostics(); return 0;
        case WM_DPICHANGED: {
            auto rect = reinterpret_cast<RECT*>(lParam);
            SetWindowPos(window, nullptr, rect->left, rect->top, rect->right - rect->left, rect->bottom - rect->top, SWP_NOZORDER | SWP_NOACTIVATE);
            DiagnosticsFont(); LayoutDiagnostics(); return 0;
        }
        case WM_GETMINMAXINFO: {
            const auto dpi = GetDpiForWindow(window);
            RECT rect{0, 0, MulDiv(580, dpi, 96), MulDiv(350, dpi, 96)};
            AdjustWindowRectExForDpi(&rect, WS_OVERLAPPEDWINDOW, FALSE, WS_EX_TOOLWINDOW | WS_EX_CONTROLPARENT, dpi);
            reinterpret_cast<MINMAXINFO*>(lParam)->ptMinTrackSize = {rect.right - rect.left, rect.bottom - rect.top}; return 0;
        }
        case WM_DRAWITEM: DrawButton(reinterpret_cast<DRAWITEMSTRUCT*>(lParam)); return TRUE;
        case WM_ERASEBKGND: {
            RECT rect; GetClientRect(window, &rect); FillRect(reinterpret_cast<HDC>(wParam), &rect, surface_); return 1;
        }
        case WM_CTLCOLORSTATIC: case WM_CTLCOLOREDIT:
            SetTextColor(reinterpret_cast<HDC>(wParam), colors_.ink); SetBkColor(reinterpret_cast<HDC>(wParam), colors_.input);
            return reinterpret_cast<LRESULT>(input_);
        case WM_DESTROY:
            KillTimer(window, DIAGNOSTICS_TIMER);
            ++diagnosticsEpoch_; diagnosticsReadPending_ = false;
            diagnosticsWindow_ = diagnosticsOutput_ = diagnosticsRefresh_ = diagnosticsClose_ = nullptr;
            if (diagnosticsFont_) { DeleteObject(diagnosticsFont_); diagnosticsFont_ = nullptr; }
            return 0;
        }
        return DefWindowProcW(window, message, wParam, lParam);
    }
    static LRESULT CALLBACK DiagnosticsWindowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
        auto self = reinterpret_cast<Application*>(GetWindowLongPtrW(window, GWLP_USERDATA));
        if (message == WM_NCCREATE) {
            self = static_cast<Application*>(reinterpret_cast<CREATESTRUCTW*>(lParam)->lpCreateParams);
            self->diagnosticsWindow_ = window; SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
        }
        if (!self) return DefWindowProcW(window, message, wParam, lParam);
        try { return self->HandleDiagnostics(window, message, wParam, lParam); }
        catch (const std::exception& error) {
            if (self->diagnosticsOutput_) self->Text(self->diagnosticsOutput_, L"网络诊断不可用：" + Wide(error.what()));
            return message == WM_CREATE ? -1 : 0;
        }
    }
    void OpenNetworkDiagnostics() {
        if (!ready_ || stopping_) return;
        if (diagnosticsWindow_) { ShowWindow(diagnosticsWindow_, SW_RESTORE); SetForegroundWindow(diagnosticsWindow_); return; }
        const auto name = className_ + L".NetworkDiagnostics";
        WNDCLASSEXW type{}; type.cbSize = sizeof(type);
        if (!GetClassInfoExW(instance_, name.c_str(), &type)) {
            type.hInstance = instance_; type.lpfnWndProc = DiagnosticsWindowProc; type.lpszClassName = name.c_str();
            type.hCursor = LoadCursorW(nullptr, IDC_ARROW); type.hIcon = LoadIconW(instance_, MAKEINTRESOURCEW(101)); type.hIconSm = type.hIcon;
            if (!RegisterClassExW(&type)) throw std::runtime_error(WindowsError("注册诊断窗口"));
        }
        RECT owner; GetWindowRect(window_, &owner);
        RECT rect{0, 0, S(840), S(640)}; const DWORD extra = WS_EX_TOOLWINDOW | WS_EX_CONTROLPARENT;
        AdjustWindowRectExForDpi(&rect, WS_OVERLAPPEDWINDOW, FALSE, extra, dpi_);
        const int width = rect.right - rect.left, height = rect.bottom - rect.top;
        MONITORINFO monitor{sizeof(monitor)}; GetMonitorInfoW(MonitorFromWindow(window_, MONITOR_DEFAULTTONEAREST), &monitor);
        const int x = std::max(monitor.rcWork.left, owner.left + (owner.right - owner.left - width) / 2);
        const int y = std::max(monitor.rcWork.top, owner.top + (owner.bottom - owner.top - height) / 2);
        if (!CreateWindowExW(extra, name.c_str(), L"网络诊断 · 本机节点", WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN, x, y, width, height, window_, nullptr, instance_, this))
            throw std::runtime_error(WindowsError("创建诊断窗口"));
        if (!SetTimer(diagnosticsWindow_, DIAGNOSTICS_TIMER, 2000, nullptr)) {
            const auto error = WindowsError("启动诊断自动刷新");
            DestroyWindow(diagnosticsWindow_); throw std::runtime_error(error);
        }
        ShowWindow(diagnosticsWindow_, SW_SHOWNORMAL); ReadNetworkDiagnostics();
    }
    void Command(int id) {
        try {
            switch (id) {
            case NAV_CONNECTION: case NAV_API: case NAV_LOGS: case NAV_PROXY: case NAV_SETTINGS:
                if ((id == NAV_API && !Capability("model") && !ModelApi().value("listening", false)) || (id == NAV_PROXY && !Capability("proxy"))) break;
                page_ = id - NAV_CONNECTION; Visibility(); break;
            case ROLE_CLIENT: case ROLE_HOST:
                if (statusAvailable_ && Identity().value("loaded", false) && !RoleLocked() && !testing_) Action(L"/api/identity", {{"role", id == ROLE_CLIENT ? "client" : "host"}}, "identity");
                break;
            case MINIMIZE_TRAY: case TRAY_HIDE: HideToTray(); break;
            case TRAY_RESTORE: Restore(); break;
            case TRAY_EXIT: DestroyWindow(window_); break;
            case STARTUP_ENABLE: SetStartup(); break;
            case THEME_TOGGLE: ToggleTheme(); break;
            case NETWORK_CONNECT: Action(L"/api/network/login", Json::object(), "login"); break;
            case NETWORK_DISCONNECT: Action(L"/api/network/disconnect", Json::object(), "network-disconnect"); break;
            case NETWORK_REFRESH: Action(L"/api/tailscale", Json::object(), "refresh"); break;
            case NETWORK_DIAGNOSTICS: OpenNetworkDiagnostics(); break;
            case NETWORK_SPEED_TEST: OpenSpeedTest(); break;
            case NETWORK_LOGIN: if (!authUrl_.empty() && SafeLoginUrl(authUrl_)) OpenLink(window_, Wide(authUrl_)); break;
            case PAIR_JOIN:
                if (IsWindowEnabled(Item(PAIR_JOIN))) {
                    const auto pairingUi = DesktopPairingUi::FromStatus(status_);
                    if (pairingUi.valid) Action(L"/api/disconnect", Json::object(), "disconnect");
                    else if (pairingUi.editable) Action(L"/api/join", {{"invitation", Utf8(Value(INVITATION))}}, "join");
                }
                break;
            case PAIR_HOST: Action(L"/api/host", Json::object(), "host"); break;
            case MODEL_ENABLE: {
                int seconds = ConfigNumber(MODEL_TIMEOUT, 1, 3600, "单次最长时间必须为 1–3600 秒");
                int turns = ConfigNumber(MODEL_MAX_TURNS, 1, 200, "单次推理轮数必须为 1–200 的整数");
                SaveSettings(); Action(L"/api/model", {{"enabled", true}, {"workspace", Utf8(Value(WORKSPACE))}, {"claudeCommand", Utf8(Value(CLAUDE_COMMAND))}, {"timeoutMs", seconds * 1000}, {"maxTurns", turns}}, "model"); break;
            }
            case MODEL_DISABLE: Action(L"/api/model", {{"enabled", false}}, "model"); break;
            case MODEL_API_TOGGLE:
                if (IsWindowEnabled(Item(MODEL_API_TOGGLE))) Action(L"/api/model-api", {{"enabled", !ModelApi().value("listening", false) && !ModelApi().value("enabled", false)}}, "model-api");
                break;
            case MODELS_REFRESH:
                Text(modelStatus_, L"正在从 服务端 刷新 Claude 模型列表…");
                Action(L"/api/models/refresh", Json::object(), "models"); break;
            case PAIR_DISCONNECT: Action(L"/api/disconnect", Json::object(), "disconnect"); break;
            case PAIR_PAUSE: Action(L"/api/pause", Json::object(), "pause"); break;
            case PAIR_RESUME: Action(L"/api/reconnect", Json::object(), "reconnect"); break;
            case PAIR_TOGGLE:
                if (IsWindowEnabled(Item(PAIR_TOGGLE))) {
                    const auto pairingUi = DesktopPairingUi::FromStatus(status_);
                    Action(pairingUi.resume ? L"/api/reconnect" : L"/api/pause", Json::object(), pairingUi.resume ? "reconnect" : "pause");
                }
                break;
            case BROWSE_WORKSPACE: Browse(); break;
            case PROBE_CLAUDE: Action(L"/api/probe", {{"claudeCommand", Utf8(Value(CLAUDE_COMMAND))}}, "probe"); break;
            case PROXY_ENABLE: Action(L"/api/proxy", {{"enabled", !proxy_.value("enabled", false)}}, "proxy"); break;
            case PROXY_SHARING: Action(L"/api/proxy", {{"sharing", !proxy_.value("sharing", false)}}, "proxy"); break;
            case COPY_SUBSCRIPTION: Action(L"/api/proxy", Json::object(), "proxy-copy"); break;
            case COPY_INVITE: Clipboard(window_, Wide(invitation_)); Report(L"配对码已复制"); break;
            case COPY_ENDPOINT: Clipboard(window_, Value(API_ENDPOINT)); Report(L"模型 Base URL 已复制"); break;
            case COPY_TOKEN: Clipboard(window_, Wide(token_)); Report(L"API 令牌已复制"); break;
            case COPY_MODEL: if (ModelsReady()) { Clipboard(window_, SelectedModel()); Report(L"Model ID 已复制"); } break;
            case COPY_EXAMPLE: {
                if (ModelsReady()) { Clipboard(window_, DesktopModelApi::PowerShellExample(options_.directory, options_.port, SelectedModel())); Report(L"所选模型 API 的 PowerShell 示例已复制"); } break;
            }
            case TEST_SEND: StartTest(); break;
            case TEST_CANCEL: if (!requestId_.empty()) Action(L"/v1/requests/" + Wide(requestId_) + L"/cancel", Json::object(), "cancel"); break;
            case OPEN_DATA: OpenLink(window_, options_.directory.wstring()); break;
            case OPEN_LICENSES: OpenLink(window_, L"http://127.0.0.1:" + std::to_wstring(ControlPort()) + L"/licenses"); break;
            }
        } catch (const std::exception& error) { Message(Wide(error.what()), true); }
    }
    void Stop() {
        if (stopping_.exchange(true)) return;
        if (diagnosticsWindow_) DestroyWindow(diagnosticsWindow_);
        if (speedTestWindow_) DestroyWindow(speedTestWindow_);
        SaveSettings(); SetEvent(wake_.value);
        {
            std::lock_guard lock(engineMutex_);
            if (process_.value && WaitForSingleObject(process_.value, 0) == WAIT_TIMEOUT) {
                if (ready_) { try { Json body = Json::object(); Api(ControlPort(), token_, L"/api/shutdown", &body, 1000); } catch (...) {} }
                WaitForSingleObject(process_.value, 1500);
            }
            DrainOwnedJob(job_.value, process_.value);
            job_.reset();
        }
        for (auto* thread : {&pollThread_, &actionThread_, &testThread_, &diagnosticsThread_, &speedTestThread_, &speedStatusThread_}) if (thread->joinable()) thread->join();
        {
            std::lock_guard lock(speedCancelMutex_); speedCancelStopping_ = true; pendingSpeedCancel_.clear();
        }
        speedCancelWake_.notify_one();
        if (speedCancelThread_.joinable()) speedCancelThread_.join();
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
        case WM_CTLCOLORLISTBOX:
            SetTextColor(reinterpret_cast<HDC>(wParam), colors_.ink); SetBkColor(reinterpret_cast<HDC>(wParam), colors_.input);
            return reinterpret_cast<LRESULT>(input_);
        case WM_CTLCOLORSTATIC: case WM_CTLCOLOREDIT: case WM_CTLCOLORBTN: {
            HDC dc = reinterpret_cast<HDC>(wParam); HWND child = reinterpret_cast<HWND>(lParam);
            for (const auto& item : widgets_) if (item.window == child) {
                SetTextColor(dc, item.muted ? colors_.muted : colors_.ink);
                SetBkMode(dc, OPAQUE);
                COLORREF color = item.sidebar ? colors_.sidebar : item.edit ? colors_.input : item.page >= 0 ? colors_.surface : colors_.background;
                SetBkColor(dc, color);
                return reinterpret_cast<LRESULT>(item.sidebar ? sidebar_ : item.edit ? input_ : item.page >= 0 ? surface_ : background_);
            }
            break;
        }
        case WM_COMMAND:
            if (LOWORD(wParam) == API_MODEL && HIWORD(wParam) == CBN_SELCHANGE) selectedModel_ = SelectedModel();
            else if (HIWORD(wParam) == BN_CLICKED || HIWORD(wParam) == 0) Command(LOWORD(wParam));
            return 0;
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
        background_ = CreateSolidBrush(colors_.background); surface_ = CreateSolidBrush(colors_.surface);
        sidebar_ = CreateSolidBrush(colors_.sidebar); input_ = CreateSolidBrush(colors_.input);
        wake_.reset(CreateEventW(nullptr, TRUE, FALSE, nullptr)); taskbarMessage_ = RegisterWindowMessageW(L"TaskbarCreated");
    }
    ~Application() { Stop(); for (auto font : fonts_) if (font) DeleteObject(font); if (iconFont_) DeleteObject(iconFont_); for (auto brush : {background_, surface_, sidebar_, input_}) if (brush) DeleteObject(brush); }
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
        INITCOMMONCONTROLSEX controls{sizeof(controls), ICC_STANDARD_CLASSES | ICC_LISTVIEW_CLASSES | ICC_PROGRESS_CLASS}; InitCommonControlsEx(&controls);
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
        while (GetMessageW(&message, nullptr, 0, 0) > 0) {
            if (diagnosticsWindow_ && IsDialogMessageW(diagnosticsWindow_, &message)) continue;
            if (speedTestWindow_ && IsDialogMessageW(speedTestWindow_, &message)) continue;
            if (!IsDialogMessageW(window_, &message)) { TranslateMessage(&message); DispatchMessageW(&message); }
        }
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
        if (options.version) {
            std::string text = "Claude Bridge " BRIDGE_VERSION " / C++ native desktop / embedded Tailscale";
            if constexpr (BRIDGE_DIAGNOSTICS_BUILD) text += " / local diagnostics (本地诊断版) / " BRIDGE_BUILD_LABEL;
            text += '\n';
            DWORD written; WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text.data(), static_cast<DWORD>(text.size()), &written, nullptr);
            if (SUCCEEDED(com)) CoUninitialize();
            return 0;
        }
        Application application(instance, std::move(options)); int result = application.Run();
        if (SUCCEEDED(com)) CoUninitialize();
        return result;
    } catch (const std::exception& error) { MessageBoxW(nullptr, Wide(error.what()).c_str(), APP_TITLE, MB_ICONERROR); if (SUCCEEDED(com)) CoUninitialize(); return 1; }
}
