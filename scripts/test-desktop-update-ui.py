"""Exercise the real updater UI and local ready callback in an isolated demo desktop."""
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request
import uuid

from build_desktop_fixture import build_fixture
from build_support import ROOT
from test_support import TemporaryTestDirectory, available_port_pair, management_port

user = ctypes.WinDLL('user32', use_last_error=True)
kernel = ctypes.WinDLL('kernel32', use_last_error=True)
callback = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user.EnumWindows.argtypes = [callback, wintypes.LPARAM]
user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user.GetDlgItem.argtypes = [wintypes.HWND, ctypes.c_int]
user.GetDlgItem.restype = wintypes.HWND
user.IsWindowEnabled.argtypes = [wintypes.HWND]
user.SendMessageTimeoutW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM, wintypes.UINT, wintypes.UINT, ctypes.POINTER(ctypes.c_size_t)]
user.SendMessageTimeoutW.restype = ctypes.c_size_t
kernel.CreateEventW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR]
kernel.CreateEventW.restype = wintypes.HANDLE
kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
kernel.CloseHandle.argtypes = [wintypes.HANDLE]


def until(read, label, process, seconds=25):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        assert process.poll() is None, (label, process.returncode)
        result = read()
        if result:
            return result
        time.sleep(.025)
    raise TimeoutError(label)


def main():
    with TemporaryTestDirectory('desktop-update-ui-') as root:
        namespace = 'update-' + uuid.uuid4().hex
        resources = ROOT / 'bin/desktop-build'
        executable = build_fixture(namespace, root / 'fixture', ROOT / 'test/desktop-update-ui.cpp', resources_directory=resources)
        mode = root / 'mode.txt'
        mode.write_text('latest')
        profile = root / 'profile'
        profile.mkdir()
        marker = profile / 'preserve-me.txt'
        marker.write_text('existing profile data')
        port = available_port_pair()
        event_name = 'Local\\ClaudeBridge.UpdateReady.' + uuid.uuid4().hex + uuid.uuid4().hex
        ready = kernel.CreateEventW(None, True, False, event_name)
        assert ready
        env = os.environ.copy()
        env['BRIDGE_UPDATE_UI_FIXTURE'] = str(mode)
        process = subprocess.Popen([str(executable), '--demo', '--minimized', '--port', str(port), '--data-dir', str(profile),
                                    '--update-ready-event', event_name], env=env, creationflags=subprocess.CREATE_NO_WINDOW)
        window = None
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        token = None
        def find_window():
            found = []
            @callback
            def visit(hwnd, _):
                owner = wintypes.DWORD()
                user.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
                if owner.value == process.pid:
                    name = ctypes.create_unicode_buffer(256)
                    user.GetClassNameW(hwnd, name, len(name))
                    if name.value == 'ClaudeBridge.Desktop.Test.' + namespace:
                        found.append(hwnd)
                return True
            user.EnumWindows(visit, 0)
            return found[0] if found else None
        def send(hwnd, message, wparam=0, lparam=0):
            owner = wintypes.DWORD()
            user.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
            assert process.poll() is None and owner.value == process.pid, 'Refusing unrelated window'
            result = ctypes.c_size_t()
            assert user.SendMessageTimeoutW(hwnd, message, wparam, lparam, 2, 2000, ctypes.byref(result))
            return result.value
        def text(control):
            data = ctypes.create_unicode_buffer(8192)
            send(user.GetDlgItem(window, control), 0x000D, len(data), ctypes.addressof(data))
            return data.value
        def click():
            control = user.GetDlgItem(window, 300)
            assert user.IsWindowEnabled(control)
            send(window, 0x0111, 300, control)
        try:
            window = until(find_window, 'isolated desktop window', process)
            until(lambda: kernel.WaitForSingleObject(ready, 0) == 0, 'new local engine ready signal', process)
            with opener.open(urllib.request.Request(f'http://127.0.0.1:{management_port(port)}/api/bootstrap', headers={'X-Bridge-UI': '1'}), timeout=3) as response:
                token = json.load(response)['token']
            send(window, 0x0111, 104)  # Settings; the fixture stays hidden.
            click()
            until(lambda: '暂无版本号更高' in text(301), 'no update state', process)
            mode.write_text('check-cancel')
            click()
            until(lambda: text(300) == '取消检查', 'cancel check enabled', process)
            click()
            until(lambda: '已取消' in text(301), 'check cancellation', process)
            mode.write_text('error')
            click()
            until(lambda: '模拟网络不可用' in text(301), 'network error', process)
            mode.write_text('available')
            click()
            until(lambda: text(300) == '更新并重启', 'new release button', process)
            assert '99.0.0' in text(301)
            mode.write_text('download-cancel')
            click()
            until(lambda: '50%' in text(301), 'download progress', process)
            click()
            until(lambda: '已取消' in text(301), 'download cancellation', process)
            assert text(300) == '更新并重启'
            mode.write_text('bad-download')
            click()
            until(lambda: '模拟文件校验失败' in text(301), 'failed download preserves desktop', process)
            assert text(300) == '检查更新', 'Retry must reread changed release metadata'
            assert marker.read_text() == 'existing profile data'
            print('PASS: real hidden desktop update controls, latest/new/error/progress/cancel states and local ready callback; profile preserved.', flush=True)
        finally:
            if process.poll() is None and window:
                send(window, 0x0111, 202)  # Only this fixture's normal tray-exit command.
                process.wait(timeout=20)
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)
            kernel.CloseHandle(ready)
        assert process.returncode == 0
        print('PASS: updater desktop exits normally with no remaining owned worker.', flush=True)


if __name__ == '__main__':
    main()
