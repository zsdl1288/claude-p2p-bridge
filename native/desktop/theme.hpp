#pragma once
#include "platform.hpp"

namespace DesktopTheme {
struct Palette {
    COLORREF background, sidebar, surface, input, ink, muted, line;
    COLORREF hover, selected, primary, primaryInk, disabled, disabledInk;
    COLORREF green, greenFill, greenLine, yellow, yellowFill, yellowLine, red, redFill, redLine;
    COLORREF button, buttonInk, buttonLine, buttonHover;
};
inline Palette Colors(bool dark) {
    if (dark) return {
        RGB(33,33,33), RGB(23,23,23), RGB(38,38,38), RGB(47,47,47), RGB(236,236,236), RGB(167,167,167), RGB(61,61,61),
        RGB(51,51,51), RGB(55,55,55), RGB(67,115,228), RGB(255,255,255), RGB(44,49,57), RGB(132,143,160),
        RGB(115,218,163), RGB(30,52,40), RGB(47,87,63), RGB(243,205,112), RGB(57,48,29), RGB(103,84,39),
        RGB(245,153,153), RGB(59,36,36), RGB(106,58,58),
        RGB(36,51,73), RGB(171,204,255), RGB(65,88,121), RGB(47,67,96)
    };
    return {
        RGB(255,255,255), RGB(249,249,249), RGB(255,255,255), RGB(250,250,250), RGB(23,23,23), RGB(115,115,115), RGB(229,229,229),
        RGB(239,239,239), RGB(234,234,234), RGB(40,99,215), RGB(255,255,255), RGB(236,240,246), RGB(136,146,163),
        RGB(30,120,76), RGB(237,248,240), RGB(199,229,208), RGB(151,103,17), RGB(255,248,229), RGB(239,220,171),
        RGB(179,58,58), RGB(253,240,240), RGB(239,209,209),
        RGB(236,243,255), RGB(37,82,157), RGB(188,208,239), RGB(221,234,255)
    };
}
inline void NativeControls(HWND window, bool dark, bool application = false) {
    // Optional native dark-theme support; absent exports leave standard controls usable.
    auto library = LoadLibraryW(L"uxtheme.dll");
    if (!library) return;
    using AllowWindow = BOOL(WINAPI*)(HWND, BOOL);
    using PreferredMode = int(WINAPI*)(int);
    if (application) {
        auto preferred = reinterpret_cast<PreferredMode>(reinterpret_cast<void*>(GetProcAddress(library, MAKEINTRESOURCEA(135))));
        if (preferred) preferred(dark ? 2 : 3);
    }
    auto allow = reinterpret_cast<AllowWindow>(reinterpret_cast<void*>(GetProcAddress(library, MAKEINTRESOURCEA(133))));
    if (allow) allow(window, dark);
    FreeLibrary(library);
}
inline void TitleBar(HWND window, bool dark, const Palette& colors) {
    // Unsupported DWM attributes on older Windows versions safely keep the OS defaults.
    auto library = LoadLibraryW(L"dwmapi.dll");
    if (!library) return;
    using SetAttribute = HRESULT(WINAPI*)(HWND, DWORD, LPCVOID, DWORD);
    auto set = reinterpret_cast<SetAttribute>(reinterpret_cast<void*>(GetProcAddress(library, "DwmSetWindowAttribute")));
    if (set) {
        BOOL enabled = dark;
        set(window, 20, &enabled, sizeof(enabled));
        set(window, 35, &colors.background, sizeof(COLORREF));
        set(window, 36, &colors.ink, sizeof(COLORREF));
    }
    FreeLibrary(library);
}
}
