#include "../native/desktop/platform.hpp"
#include "../native/desktop/ids.hpp"

namespace {
HWND FailLateControlCreation(DWORD extended, LPCWSTR type, LPCWSTR text, DWORD style,
                            int x, int y, int width, int height, HWND parent, HMENU menu,
                            HINSTANCE instance, LPVOID parameter) {
    // Fail after the host inputs exist, but before InitUi loads desktop.ini.
    if (parent && reinterpret_cast<INT_PTR>(menu) == MODEL_MAX_TURNS) {
        SetLastError(ERROR_NOT_ENOUGH_MEMORY); return nullptr;
    }
    return CreateWindowExW(extended, type, text, style, x, y, width, height, parent, menu, instance, parameter);
}
int IgnoreExpectedFailure(HWND, LPCWSTR, LPCWSTR, UINT) { return IDOK; }
}

#define CreateWindowExW FailLateControlCreation
#define MessageBoxW IgnoreExpectedFailure
#include "../native/desktop/main.cpp"
