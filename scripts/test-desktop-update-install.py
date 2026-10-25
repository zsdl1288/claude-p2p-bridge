"""Run an actual desktop/helper/engine update entirely inside a disposable fixture.

Only GitHub metadata and remote bytes are replaced at C++ source level. Build
both desktops with the same random single-instance namespace; never launch a
normal release or inspect/control a user's production desktop.
"""
import argparse
import configparser
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.error
import urllib.request
import uuid

from build_desktop_fixture import build_fixture
from build_support import ROOT, VERSION
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
user.IsWindowVisible.argtypes = [wintypes.HWND]
user.SendMessageTimeoutW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
                                   wintypes.UINT, wintypes.UINT, ctypes.POINTER(ctypes.c_size_t)]
user.SendMessageTimeoutW.restype = ctypes.c_size_t
kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel.OpenProcess.restype = wintypes.HANDLE
kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
kernel.WaitForSingleObject.restype = wintypes.DWORD
kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
kernel.CloseHandle.argtypes = [wintypes.HANDLE]
kernel.K32EnumProcesses.argtypes = [ctypes.POINTER(wintypes.DWORD), wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]


def sha256(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def resource_version(directory):
    value = (Path(directory) / 'build_config.hpp').read_text(encoding='utf-8')
    match = re.search(r'^#define BRIDGE_VERSION "(\d+\.\d+\.\d+)"$', value, re.MULTILINE)
    if not match or not (Path(directory) / 'resources.o').is_file():
        raise AssertionError(f'Missing matching desktop resources: {directory}')
    return match.group(1)


def wait_until(read, label, seconds=35):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = read()
        if value:
            return value
        time.sleep(.04)
    raise TimeoutError(label)


class OwnedProcess:
    """Pin a process handle only after its image is inside this exact fixture."""
    def __init__(self, pid, root, expected=None):
        self.pid, self.handle = pid, None
        handle = kernel.OpenProcess(0x1000 | 0x100000 | 0x0001, False, pid)
        if not handle:
            raise OSError(ctypes.get_last_error(), 'Cannot inspect fixture process')
        try:
            text = ctypes.create_unicode_buffer(32768)
            length = wintypes.DWORD(len(text))
            if not kernel.QueryFullProcessImageNameW(handle, 0, text, ctypes.byref(length)):
                raise OSError(ctypes.get_last_error(), 'Cannot identify fixture process')
            image = Path(text.value)
            if not image.is_absolute() or not image.is_relative_to(root) or (expected and image != expected):
                raise ValueError('Refusing a process outside this isolated fixture')
            self.image, self.handle = image, handle
        except BaseException:
            kernel.CloseHandle(handle)
            raise

    def alive(self):
        return kernel.WaitForSingleObject(self.handle, 0) == 258

    def wait(self, seconds=25):
        assert kernel.WaitForSingleObject(self.handle, int(seconds * 1000)) == 0, ('fixture process did not exit', self.pid)
        code = wintypes.DWORD()
        assert kernel.GetExitCodeProcess(self.handle, ctypes.byref(code))
        return code.value

    def close(self):
        if self.handle:
            kernel.CloseHandle(self.handle)
            self.handle = None


def fixture_processes(root):
    capacity = 4096
    while True:
        values = (wintypes.DWORD * capacity)()
        used = wintypes.DWORD()
        assert kernel.K32EnumProcesses(values, ctypes.sizeof(values), ctypes.byref(used))
        if used.value < ctypes.sizeof(values):
            break
        capacity *= 2
        assert capacity <= 65536
    result = []
    for pid in values[:used.value // ctypes.sizeof(wintypes.DWORD)]:
        if not pid:
            continue
        try:
            process = OwnedProcess(pid, root)
            if process.alive():
                result.append(process)
            else:
                process.close()
        except (OSError, ValueError):
            pass
    return result


def windows(namespace):
    found = []
    @callback
    def visit(hwnd, _):
        name = ctypes.create_unicode_buffer(256)
        user.GetClassNameW(hwnd, name, len(name))
        if name.value == 'ClaudeBridge.Desktop.Test.' + namespace:
            owner = wintypes.DWORD()
            user.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
            found.append((hwnd, owner.value))
        return True
    user.EnumWindows(visit, 0)
    return found


def send(process, hwnd, message, wparam=0, lparam=0):
    owner = wintypes.DWORD()
    user.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
    assert process.alive() and owner.value == process.pid, 'Refusing an unrelated window'
    result = ctypes.c_size_t()
    assert user.SendMessageTimeoutW(hwnd, message, wparam, lparam, 2, 20000, ctypes.byref(result)), 'Fixture window did not respond'
    return result.value


def text(process, window, control):
    value = ctypes.create_unicode_buffer(8192)
    send(process, user.GetDlgItem(window, control), 0x000D, len(value), ctypes.addressof(value))
    return value.value


def click_update(process, window):
    control = user.GetDlgItem(window, 300)
    assert user.IsWindowEnabled(control)
    send(process, window, 0x0111, 300, control)


def journal(profile):
    path = profile / 'diagnostics/lifecycle/desktop.jsonl'
    if not path.is_file():
        return []
    # The last line may still be in flight; only parse newline-terminated rows.
    content = path.read_text(encoding='utf-8')
    return [json.loads(line) for line in content.splitlines(keepends=True) if line.endswith('\n')]


def clean_processes(root, namespace):
    """Normal tray exit first; failure cleanup is limited to pinned fixture PIDs."""
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        owned = fixture_processes(root)
        if not owned:
            return
        by_pid = {process.pid: process for process in owned}
        try:
            for hwnd, pid in windows(namespace):
                if pid in by_pid:
                    try:
                        send(by_pid[pid], hwnd, 0x0111, 202)
                    except (AssertionError, OSError):
                        pass
        finally:
            for process in owned:
                process.close()
        time.sleep(.1)
    # The fixture may have failed inside a helper dialog before a main window.
    # Every target is re-opened and its exact executable path checked above.
    for process in fixture_processes(root):
        try:
            if process.alive():
                assert kernel.TerminateProcess(process.handle, 1)
                process.wait(10)
        finally:
            process.close()
    def none_remain():
        remaining = fixture_processes(root)
        for process in remaining:
            process.close()
        return not remaining
    wait_until(none_remain, 'owned fixture processes cleaned', 10)


def main(old_resources, new_resources):
    # Fail before compiling/running anything if the release build has not yet
    # regenerated the new embedded engine/version resource pair.
    old_version = resource_version(old_resources)
    assert old_version == '1.2.11', 'Need saved 1.2.11 resources'
    assert resource_version(new_resources) == VERSION, f'Build the current {VERSION} resources first'
    assert tuple(map(int, VERSION.split('.'))) > tuple(map(int, old_version.split('.'))), 'Target release must be newer than the saved baseline'
    new_config = (Path(new_resources) / 'build_config.hpp').read_text(encoding='utf-8')
    diagnostics = re.search(r'^#define\s+BRIDGE_DIAGNOSTICS_BUILD\s+([^\r\n]+)$', new_config, re.MULTILINE)
    assert diagnostics is None or diagnostics.group(1).strip() == '0', 'Use the current formal release resources, not a diagnostics build'
    with TemporaryTestDirectory('desktop-update-install-') as root:
        namespace = 'update-install-' + uuid.uuid4().hex
        source = ROOT / 'test/desktop-update-install.cpp'
        target = build_fixture(namespace, root / 'installed', source, resources_directory=old_resources)
        candidate = build_fixture(namespace, root / 'candidate', source, resources_directory=new_resources)
        old_hash, new_hash = sha256(target), sha256(candidate)
        assert old_hash != new_hash
        version, tag = VERSION, f'v{VERSION}'
        name = f'ClaudeBridge-{version}-windows-x64.exe'
        source_file = root / 'source.json'
        source_file.write_text(json.dumps({'candidate': str(candidate), 'release': {
            'tag_name': tag, 'draft': False, 'prerelease': False,
            'html_url': f'https://github.com/zsdl1288/claude-p2p-bridge/releases/tag/{tag}',
            'assets': [{'name': name, 'state': 'uploaded', 'size': candidate.stat().st_size,
                        'digest': f'sha256:{new_hash}', 'browser_download_url':
                        f'https://github.com/zsdl1288/claude-p2p-bridge/releases/download/{tag}/{name}'}]}}), encoding='utf-8')
        profile, temp, workspace = root / 'profile', root / 'temp', root / 'workspace'
        for path in (profile, temp, workspace):
            path.mkdir()
        marker = profile / 'preserve-me.json'
        marker_value = json.dumps({'marker': uuid.uuid4().hex, 'purpose': 'update must preserve existing profile'})
        marker.write_text(marker_value, encoding='utf-8')
        settings = profile / 'desktop.ini'
        settings.write_text(f'[host]\nworkspace={workspace}\nclaude=fixture-claude\ntimeoutSeconds=321\nmaxTurns=7\n[appearance]\ntheme=dark\n', encoding='utf-8')
        port = available_port_pair()
        env = os.environ.copy()
        env.pop('BRIDGE_API_TOKEN', None)  # Exercise only this profile's persisted token.
        env.update(BRIDGE_UPDATE_INSTALL_FIXTURE=str(source_file), TEMP=str(temp), TMP=str(temp))
        child = subprocess.Popen([str(target), '--demo', '--minimized', '--port', str(port), '--data-dir', str(profile)],
                                 env=env, creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            old = OwnedProcess(child.pid, root, target)
        except BaseException:
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=10)
            raise
        new = old_engine = new_engine = None
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        def read_api(route, version):
            try:
                headers = {'X-Bridge-UI': '1'} if route == '/api/bootstrap' else {}
                with opener.open(urllib.request.Request(f'http://127.0.0.1:{management_port(port)}{route}', headers=headers), timeout=2) as response:
                    value = json.load(response)
                return value if value.get('version') == version else None
            except (OSError, urllib.error.URLError):
                return None
        try:
            old_window = wait_until(lambda: next((hwnd for hwnd, pid in windows(namespace) if pid == old.pid), None), 'old isolated desktop')
            health = wait_until(lambda: read_api('/health', old_version), 'old real engine health')
            assert health['ok'] and health['service'] == 'claude-p2p-bridge'
            old_engine = OwnedProcess(health['parentPid'], root)
            assert old_engine.image.is_relative_to(profile / 'engine')
            old_boot = wait_until(lambda: read_api('/api/bootstrap', old_version), 'old engine bootstrap')
            assert old_boot['api'] == f'http://127.0.0.1:{port}' and old_boot['token']
            assert not user.IsWindowVisible(old_window), 'Fixture must remain minimized'
            send(old, old_window, 0x0111, 104)
            click_update(old, old_window)
            wait_until(lambda: text(old, old_window, 300) == '更新并重启', 'new release offered')
            assert version in text(old, old_window, 301)
            click_update(old, old_window)
            wait_until(lambda: not old.alive(), 'old desktop stopped after helper preparation', 50)
            assert child.wait(timeout=5) == 0 and old.wait(1) == 0
            assert old_engine.wait(5) == 0, 'Old owned engine must finish before replacement'
            def successor_window():
                for hwnd, pid in windows(namespace):
                    if pid != old.pid:
                        return hwnd, pid
                return None
            new_window, new_pid = wait_until(successor_window, 'replacement desktop window', 100)
            new = OwnedProcess(new_pid, root, target)
            health = wait_until(lambda: read_api('/health', version), 'new real engine health', 100)
            assert health['ok'] and health['parentPid'] != old_engine.pid
            new_engine = OwnedProcess(health['parentPid'], root)
            assert new_engine.image.is_relative_to(profile / 'engine')
            boot = wait_until(lambda: read_api('/api/bootstrap', version), 'new engine bootstrap')
            assert boot['api'] == old_boot['api'] and boot['token'] == old_boot['token']
            # This text is assigned only after SignalUpdateReady has completed
            # both the engine-ready event and the helper's committed response.
            wait_until(lambda: f'已更新至 v{version}' in text(new, new_window, 301), 'two-phase ready/committed handshake')
            assert user.IsWindowEnabled(user.GetDlgItem(new_window, 300))
            assert not user.IsWindowVisible(new_window)
            assert sha256(target) == new_hash and sha256(candidate) == new_hash
            assert marker.read_text(encoding='utf-8') == marker_value
            config = configparser.ConfigParser()
            config.read(settings, encoding='utf-8-sig')
            assert dict(config['host']) == {'workspace': str(workspace), 'claude': 'fixture-claude', 'timeoutseconds': '321', 'maxturns': '7'}
            assert config['appearance']['theme'] == 'dark'
            rows = journal(profile)
            assert any(row.get('pid') == old.pid and row.get('event') == 'session-ended' and row.get('reason') == 'client-update' and row.get('exitCode') == 0 for row in rows)
            assert any(row.get('pid') == new.pid and row.get('event') == 'engine-ready' and row.get('version') == version for row in rows)
            assert not any(row.get('event') in ('previous-session-incomplete', 'startup-failed', 'fatal') for row in rows)
            assert not list(target.parent.glob('.bridge-update-*.backup.exe'))
            time.sleep(.5)
            assert new.alive() and new_engine.alive() and read_api('/health', version)
            print(f'PASS: actual {old_version}→{version} desktop/helper replacement, new embedded engine, same port/profile, update exit journal and two-phase commit.', flush=True)
            send(new, new_window, 0x0111, 202)
            assert new.wait(30) == 0 and new_engine.wait(5) == 0
            rows = journal(profile)
            assert any(row.get('pid') == new.pid and row.get('event') == 'session-ended' and row.get('reason') == 'tray-exit' and row.get('exitCode') == 0 for row in rows)
            print('PASS: replacement desktop and owned engine exit normally; no user profile, production process or registry changed.', flush=True)
        except BaseException:
            print('Isolated update journal:', json.dumps([{key: row[key] for key in ('pid', 'version', 'event', 'reason', 'exitCode') if key in row}
                                                        for row in journal(profile)[-20:]], ensure_ascii=False), flush=True)
            for error in temp.glob('ClaudeBridgeUpdate-*/error.txt'):
                print('Isolated helper error:', error.read_text(encoding='utf-8')[:2000], flush=True)
            raise
        finally:
            try:
                clean_processes(root, namespace)
            finally:
                for process in (old, new, old_engine, new_engine):
                    if process:
                        process.close()
                if child.poll() is None:
                    child.wait(timeout=5)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--old-resources', type=Path, default=ROOT / '.cache/update-previous-build-1.2.11')
    parser.add_argument('--new-resources', type=Path, default=ROOT / 'bin/desktop-build',
                        help=f'Formal desktop resources for current package version {VERSION}')
    args = parser.parse_args()
    main(args.old_resources, args.new_resources)
