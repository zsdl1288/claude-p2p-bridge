"""Exercise the self-update helper only in disposable .bridge fixtures.

No live executable, user data/profile, startup key or real singleton is used.
The two candidate binaries contain fixture-only version resources and modes.
"""
from pathlib import Path
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import time
from test_support import TemporaryTestDirectory

ROOT = Path(__file__).resolve().parent.parent
COMPILER = ROOT / '.tools/w64devkit/bin/g++.exe'
WINDRES = COMPILER.with_name('windres.exe')
if os.name != 'nt':
    raise SystemExit('Windows is required')

kernel = ctypes.WinDLL('kernel32', use_last_error=True)
kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel.OpenProcess.restype = wintypes.HANDLE
kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
kernel.CloseHandle.argtypes = [wintypes.HANDLE]
kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]


def read_when(path, timeout=12):
    start = time.monotonic()
    while time.monotonic() - start < timeout:
        try:
            return json.loads(path.read_text(encoding='utf-8'))
        except (FileNotFoundError, PermissionError, json.JSONDecodeError):
            time.sleep(.025)
    raise AssertionError(f'Timed out waiting for {path}')


def process_handle(record):
    handle = kernel.OpenProcess(0x100000 | 0x1000, False, record['pid'])
    if not handle:
        return None
    image = ctypes.create_unicode_buffer(32768)
    length = wintypes.DWORD(len(image))
    if not kernel.QueryFullProcessImageNameW(handle, 0, image, ctypes.byref(length)) or Path(image.value) != Path(record['image']):
        kernel.CloseHandle(handle)
        raise AssertionError('Fixture process identity changed')
    return handle


def wait_handle(handle):
    if handle:
        try:
            assert kernel.WaitForSingleObject(handle, 15000) == 0, 'Fixture process did not exit'
        finally:
            kernel.CloseHandle(handle)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


with TemporaryTestDirectory('update-install-test-') as directory:
    namespace = 'update-install-' + secrets.token_hex(12)
    obj = directory / 'fixture.o'
    subprocess.run([str(COMPILER), '-std=c++20', '-O1', '-static', '-municode', '-Wall', '-Wextra',
                    f'-DBRIDGE_DESKTOP_TEST_NAMESPACE=L"{namespace}"', '-c',
                    str(ROOT / 'native/desktop/update-install.test.cpp'), '-o', str(obj)],
                   cwd=ROOT, check=True, timeout=120, creationflags=subprocess.CREATE_NO_WINDOW)
    binaries = []
    for revision in (0, 1):
        rc = directory / f'version-{revision}.rc'
        rc.write_text(f'''#include <windows.h>
1 VERSIONINFO
 FILEVERSION 1,0,{revision},0
 PRODUCTVERSION 1,0,{revision},0
 FILEOS VOS_NT_WINDOWS32
 FILETYPE VFT_APP
 BEGIN
  BLOCK "VarFileInfo" BEGIN VALUE "Translation", 0x409, 1200 END
 END
''', encoding='ascii')
        res = directory / f'version-{revision}.o'
        binary = directory / f'fixture-{revision}.exe'
        subprocess.run([str(WINDRES), str(rc), str(res)], check=True, timeout=30, creationflags=subprocess.CREATE_NO_WINDOW)
        subprocess.run([str(COMPILER), '-static', '-municode', str(obj), str(res), '-o', str(binary),
                        '-ladvapi32', '-lwinhttp', '-lshell32', '-lbcrypt', '-lversion'],
                       check=True, timeout=60, creationflags=subprocess.CREATE_NO_WINDOW)
        binaries.append(binary)
    subprocess.run([str(binaries[0]), '--unit', str(directory / 'unit')], check=True, timeout=15,
                   creationflags=subprocess.CREATE_NO_WINDOW)
    cases = ['success', 'timeout', 'exit-early', 'launch-fail', 'replace1177',
             'wrong-hash', 'wrong-version', 'wrong-target', 'locked', 'readonly', 'cancelled']
    for behavior in cases:
        case = directory / behavior
        case.mkdir()
        target = case / 'client with spaces.exe'
        shutil.copyfile(binaries[0], target)
        data = case / 'data with spaces'
        data.mkdir()
        (data / 'pairing.json').write_text('preserve exact pairing', encoding='utf-8')
        parent = subprocess.Popen([str(target), '--fixture-parent', str(case), str(binaries[1]), behavior],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW)
        helper = descendant = None
        if behavior in cases[:5]:
            helper = process_handle(read_when(case / 'helper.json'))
        if behavior == 'timeout':
            descendant = process_handle(read_when(case / 'descendant.json'))
        stdout, stderr = parent.communicate(timeout=15)
        assert parent.returncode == 0, (behavior, stdout.decode('utf-8'), stderr.decode('utf-8'))
        if behavior == 'success':
            read_when(case / 'committed.json')
            assert digest(target) == digest(binaries[1])
            started = read_when(case / 'new-started.json')
            assert started['args'][4:10] == ['--data-dir', str(data), '--port', '3217', '--literal', 'quote" slash\\ tail\\']
        elif behavior in cases[1:5]:
            read_when(case / 'rollback-started.json')
            assert digest(target) == digest(binaries[0]), behavior
            assert not (case / 'committed.json').exists()
        else:
            read_when(case / 'rejected.json')
            assert digest(target) == digest(binaries[0])
        wait_handle(helper)
        wait_handle(descendant)
        assert not list(case.glob('.bridge-update-*.new.exe')), 'Leaked pending executable'
        assert (data / 'pairing.json').read_text(encoding='utf-8') == 'preserve exact pairing'
        if behavior == 'success':
            staging = Path(read_when(case / 'parent-ready.json')['stage'])
            until = time.monotonic() + 3
            while staging.exists() and time.monotonic() < until:
                time.sleep(.025)
            assert not staging.exists(), 'Committed update did not clean its own helper copy'
        # Restarted fixture apps intentionally exit after a bounded 1.5 seconds.
        time.sleep(1.6 if behavior == 'success' else .2)
        print(f'PASS isolated install: {behavior}')
    print(f'Passed {len(cases)} isolated installer scenarios plus path/restore/cleanup units')
