"""Exercise packaged runtime and isolated production desktop code on Windows.

Business A/B instances use the embedded engine directly. Desktop lifecycle
tests use a compile-time namespace fixture, preserving strict release single
instance behavior and never activating an existing real user desktop.
"""
import ctypes
from ctypes import wintypes
import http.client
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request
from build_support import ROOT as root, VERSION as version
from build_desktop_fixture import build_fixture
from test_support import TemporaryTestDirectory, available_port_pair, management_port

engine = root / "bin/bridge-engine.exe"
temporary = TemporaryTestDirectory("desktop-smoke-")
directory = temporary.path
desktop = None
desktop_namespace = "smoke-" + os.urandom(12).hex()
desktop_class = "ClaudeBridge.Desktop.Test." + desktop_namespace
processes = []
clients = []
model_urls = {}
env = os.environ.copy()
env["PATH"] = str(Path(os.environ["SystemRoot"]) / "System32")
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
kernel32.WaitForSingleObject.restype = wintypes.DWORD
kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
kernel32.CloseHandle.restype = wintypes.BOOL
user32 = ctypes.WinDLL("user32", use_last_error=True)
window_callback = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user32.EnumWindows.argtypes = (window_callback, wintypes.LPARAM)
user32.EnumWindows.restype = wintypes.BOOL
user32.GetWindowThreadProcessId.argtypes = (wintypes.HWND, ctypes.POINTER(wintypes.DWORD))
user32.GetClassNameW.argtypes = (wintypes.HWND, wintypes.LPWSTR, ctypes.c_int)
user32.GetDlgItem.argtypes = (wintypes.HWND, ctypes.c_int)
user32.GetDlgItem.restype = wintypes.HWND
for name in ("IsWindow", "IsWindowEnabled", "IsWindowVisible"):
    getattr(user32, name).argtypes = (wintypes.HWND,)
    getattr(user32, name).restype = wintypes.BOOL
user32.ShowWindow.argtypes = (wintypes.HWND, ctypes.c_int)
user32.SendMessageTimeoutW.argtypes = (wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
                                      wintypes.UINT, wintypes.UINT, ctypes.POINTER(ctypes.c_size_t))
user32.SendMessageTimeoutW.restype = ctypes.c_size_t


def fixture_window(process, class_name):
    found = []

    @window_callback
    def visit(window, _):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(window, ctypes.byref(owner))
        if owner.value == process.pid:
            name = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(window, name, len(name))
            if name.value == class_name:
                found.append(window)
        return True

    user32.EnumWindows(visit, 0)
    return found[0] if found else None


def owned_fixture_window(process, window):
    owner = wintypes.DWORD()
    user32.GetWindowThreadProcessId(window, ctypes.byref(owner))
    assert process in processes and process.poll() is None and user32.IsWindow(window) and owner.value == process.pid, "Refusing to control a window outside this live test fixture"
    return window


def wait_ui(process, read, description):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        assert process.poll() is None, f"Fixture exited while waiting for {description}: {process.returncode}"
        value = read()
        if value:
            return value
        time.sleep(0.05)
    raise TimeoutError(description)


def fixture_control(process, window, control_id):
    child = user32.GetDlgItem(owned_fixture_window(process, window), control_id)
    return owned_fixture_window(process, child)


def fixture_message(process, window, message, wparam=0, lparam=0):
    result = ctypes.c_size_t()
    if not user32.SendMessageTimeoutW(owned_fixture_window(process, window), message, wparam, lparam, 2, 2000, ctypes.byref(result)):
        raise RuntimeError("Fixture window did not respond within two seconds")
    return result.value


def click_fixture(process, window, control_id):
    child = fixture_control(process, window, control_id)
    assert user32.IsWindowVisible(child) and user32.IsWindowEnabled(child), f"Fixture control {control_id} is unavailable"
    fixture_message(process, window, 0x0111, control_id, child)  # WM_COMMAND / BN_CLICKED


def fixture_text(process, window, control_id):
    buffer = ctypes.create_unicode_buffer(16384)
    fixture_message(process, fixture_control(process, window, control_id), 0x000D, len(buffer), ctypes.addressof(buffer))  # WM_GETTEXT
    return buffer.value


def diagnostic_sample_time(process, window):
    text = fixture_text(process, window, 241)
    return next((line for line in text.splitlines() if line.startswith("采样时间：") and "—" not in line), "")


def request(base, route, body=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if route == "/api/bootstrap":
        headers["X-Bridge-UI"] = "1"
    model_route = route in ("/v1/models", "/v1/chat/completions", "/v1/responses", "/v1/messages") or route.startswith("/v1/requests/")
    endpoint = model_urls[base] if model_route else base
    req = urllib.request.Request(endpoint + route, data=None if body is None else json.dumps(body).encode(), headers=headers)
    with opener.open(req, timeout=5) as response:
        return json.load(response)


def start(name, demo=False, port=None, poll_interval=0.1, wait_identity=True, desktop_mode=False):
    if port is None:
        port = available_port_pair()
    args = [str(desktop if desktop_mode else engine)]
    if not desktop_mode:
        args.append("--owned-engine")
    else:
        args.append("--minimized")
    args += ["--no-browser", "--port", str(port), "--data-dir", str(directory / name)]
    if demo:
        args.append("--demo")
    process = subprocess.Popen(args, env=env)
    processes.append(process)
    base = f"http://127.0.0.1:{management_port(port)}"
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        try:
            health = request(base, "/health")
            if health["version"] == version:
                bootstrap = request(base, "/api/bootstrap")
                token = bootstrap["token"]
                if token != (directory / name / "api-token").read_text(encoding="utf-8").strip():
                    raise ValueError("Readiness response belongs to another test profile")
                model_urls[base] = bootstrap["api"]
                clients.append((base, token))
                if wait_identity:
                    initial = wait_status(base, token, lambda state: state["identity"]["loaded"], "Identity preferences did not load")
                    assert not initial["modelApi"]["enabled"] and not initial["modelApi"]["listening"], initial
                return base, token
        except (OSError, ValueError, AssertionError, http.client.HTTPException):
            pass
        if process.poll() is not None:
            raise RuntimeError(f"{name} exited before startup (exit {process.returncode})")
        time.sleep(poll_interval)
    raise TimeoutError(f"{name} did not start")


def model_port(base):
    return int(model_urls[base].rsplit(":", 1)[1])


def enable_model_api(base, token):
    enabled = request(base, "/api/model-api", {"enabled": True}, token)
    assert enabled["modelApi"]["enabled"] and enabled["modelApi"]["listening"], enabled


def stop(base, token, process):
    request(base, "/api/shutdown", {}, token)
    process.wait(timeout=15)


def wait_status(base, token, condition, description):
    for _ in range(200):
        status = request(base, "/api/status", token=token)
        if condition(status):
            return status
        time.sleep(0.1)
    raise TimeoutError(f"{description}: {status}")


def expect_error(base, token, route, body, code=409):
    try:
        request(base, route, body, token)
    except urllib.error.HTTPError as error:
        assert error.code == code, (route, error.code, error.read().decode("utf-8"))
    else:
        raise AssertionError(f"{route} unexpectedly accepted an invalid identity transition")


def connect_identity(base, token, role):
    selected = request(base, "/api/identity", {"role": role}, token)
    assert selected["identity"]["role"] == role and selected["identity"]["canSwitchRole"], selected
    connected = request(base, "/api/network/login", {}, token)
    assert connected["identity"]["desiredOnline"] and connected["identity"]["locked"], connected
    assert not connected["identity"]["canSwitchRole"], connected
    return connected


def wait_connected(a, token_a, b, token_b):
    for _ in range(200):
        caller = request(a, "/api/status", token=token_a)
        if caller["online"] and caller["model"]["available"] and request(b, "/api/status", token=token_b)["online"]:
            return
        time.sleep(0.1)
    raise TimeoutError("Saved pairing did not reconnect")


def wait_host(b, token_b, *, connected=None, queued=None, active=None):
    for _ in range(200):
        status = request(b, "/api/status", token=token_b)
        if ((connected is None or status["connectedClients"] == connected)
                and (queued is None or status["queuedRequests"] == queued)
                and (active is None or status["activeRequests"] == active)):
            return status
        time.sleep(0.1)
    raise TimeoutError(f"Unexpected host clients / queue: {status}")


def wait_all_connected(a, token_a, a2, token_a2, b, token_b):
    wait_connected(a, token_a, b, token_b)
    wait_connected(a2, token_a2, b, token_b)
    return wait_host(b, token_b, connected=2)


def stream(base, token, prompt):
    body = json.dumps({"prompt": prompt, "stream": True}).encode()
    req = urllib.request.Request(base + "/v1/run", data=body,
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + token})
    return opener.open(req, timeout=30)


def finish_stream(response):
    with response:
        text = response.read().decode("utf-8")
    assert "event: done" in text, text
    return text


def wait_stopped(base):
    for _ in range(100):
        try:
            request(base, "/health")
        except Exception:
            return
        time.sleep(0.1)
    raise TimeoutError("Previous API is still shutting down")


try:
    failed_desktop = build_fixture(output_directory=directory / "startup-failure-fixture",
                                   source=root / "test/desktop-startup-failure.cpp")
    failed_profile = directory / "startup-failure-profile"
    failed_profile.mkdir()
    failed_ini = failed_profile / "desktop.ini"
    saved_ini = (b"[host]\r\nworkspace=C:\\SavedWorkspace\r\nclaude=C:\\SavedClaude.exe\r\n"
                 b"timeoutSeconds=123\r\nmaxTurns=17\r\n")
    failed_ini.write_bytes(saved_ini)
    failed_start = subprocess.run([str(failed_desktop), "--demo", "--data-dir", str(failed_profile)],
                                  env=env, timeout=15)
    assert failed_start.returncode == 1, "Late UI creation failure was not reported"
    assert failed_ini.read_bytes() == saved_ini, "Failed desktop startup overwrote settings before loading them"
    assert list(failed_profile.iterdir()) == [failed_ini], "Failed UI initialization started the background engine"
    print("PASS: a late native UI creation failure preserves existing desktop settings and starts no engine.", flush=True)
    desktop = build_fixture(name=desktop_namespace, output_directory=directory / "desktop-fixture")
    legacy_engine = directory / "embedded/engine" / version / "bridge-engine.exe"
    legacy_engine.parent.mkdir(parents=True)
    legacy_engine.write_bytes(b"locked old engine cache")
    with legacy_engine.open("rb"):
        base, token = start("embedded", desktop_mode=True)
    assert legacy_engine.read_bytes() == b"locked old engine cache", "Upgrade overwrote the old engine cache"
    status = request(base, "/api/tailscale", token=token)
    assert status["installed"] and status["embedded"] and not status["running"], status
    assert status["backendState"] == "NotStarted", status
    assert request(base, "/api/status", token=token)["mode"] == "tailscale"
    with opener.open(base + "/licenses", timeout=5) as response:
        assert "Tailscale" in response.read().decode("utf-8")
    # A different port and directory must still reuse the same desktop.
    duplicate_port = available_port_pair()
    duplicate = subprocess.run([str(desktop), "--minimized", "--port", str(duplicate_port),
                                "--data-dir", str(directory / "duplicate")], env=env, timeout=15)
    assert duplicate.returncode == 0
    assert request(base, "/api/bootstrap")["token"] == token
    assert not (directory / "duplicate").exists(), "Second launch wrote a profile before taking the user-wide single-instance lock"
    request(base, "/api/shutdown", {}, token)
    processes[-1].wait(timeout=15)
    # Only the namespaced desktop/PID launched here is controlled. Demo mode
    # unlocks the proxy page without Tailscale login, internet or Claude calls.
    diagnostics_base, diagnostics_token = start("diagnostics-ui", demo=True, desktop_mode=True)
    diagnostics_process = processes[-1]
    connect_identity(diagnostics_base, diagnostics_token, "host")
    diagnostics_host = request(diagnostics_base, "/api/host", {"tailscaleIp": "127.0.0.1", "bridgePort": 0}, diagnostics_token)
    main_window = wait_ui(diagnostics_process, lambda: fixture_window(diagnostics_process, desktop_class), "namespaced desktop window")
    user32.ShowWindow(owned_fixture_window(diagnostics_process, main_window), 4)  # SW_SHOWNOACTIVATE
    wait_ui(diagnostics_process, lambda: user32.IsWindowEnabled(fixture_control(diagnostics_process, main_window, 103)), "proxy page authorization")
    click_fixture(diagnostics_process, main_window, 103)  # NAV_PROXY
    click_fixture(diagnostics_process, main_window, 240)  # NETWORK_DIAGNOSTICS
    diagnostics_class = desktop_class + ".NetworkDiagnostics"
    diagnostics_window = wait_ui(diagnostics_process, lambda: fixture_window(diagnostics_process, diagnostics_class), "network diagnostics window")
    unavailable = wait_ui(diagnostics_process, lambda: (text if "数据状态：不可用" in (text := fixture_text(diagnostics_process, diagnostics_window, 241)) else None), "unavailable diagnostic snapshot")
    assert "TCP 重传：—" in unavailable and "重传不等于公网丢包率" in unavailable, unavailable
    first_sample = diagnostic_sample_time(diagnostics_process, diagnostics_window)
    assert first_sample, "The unavailable snapshot must retain its real capture timestamp"
    wait_ui(diagnostics_process, lambda: (sample if (sample := diagnostic_sample_time(diagnostics_process, diagnostics_window)) and sample != first_sample else None), "automatic diagnostic refresh without clicking refresh")
    wait_ui(diagnostics_process, lambda: user32.IsWindowEnabled(fixture_control(diagnostics_process, diagnostics_window, 242)), "diagnostic refresh readiness")
    click_fixture(diagnostics_process, diagnostics_window, 242)  # DIAGNOSTICS_REFRESH
    wait_ui(diagnostics_process, lambda: user32.IsWindowEnabled(fixture_control(diagnostics_process, diagnostics_window, 242)), "manual diagnostic refresh completion")
    assert "数据状态：不可用" in fixture_text(diagnostics_process, diagnostics_window, 241)
    click_fixture(diagnostics_process, diagnostics_window, 243)  # DIAGNOSTICS_CLOSE
    assert not user32.IsWindow(diagnostics_window), "Closing diagnostics retained its window"
    time.sleep(2.2)  # Cross one automatic refresh interval after dismissal.
    assert diagnostics_process.poll() is None and not fixture_window(diagnostics_process, diagnostics_class), "Automatic refresh revived closed diagnostics or crashed the fixture"
    # Closing immediately after another open also exercises a snapshot/close
    # race. A later reply must not recreate the dismissed diagnostics window.
    click_fixture(diagnostics_process, main_window, 240)
    diagnostics_window = wait_ui(diagnostics_process, lambda: fixture_window(diagnostics_process, diagnostics_class), "reopened diagnostics window")
    click_fixture(diagnostics_process, diagnostics_window, 243)
    time.sleep(0.2)
    assert diagnostics_process.poll() is None and not fixture_window(diagnostics_process, diagnostics_class), "A late diagnostic reply revived its window or crashed the fixture"
    click_fixture(diagnostics_process, main_window, 240)
    # Only this namespaced test desktop is operated; the user's real B is not
    # activated or stopped. The dedicated speed window must require a peer,
    # explicit B target selection and an explicit start.
    assert not user32.IsWindowEnabled(fixture_control(diagnostics_process, main_window, 260))
    speed_base, speed_token = start("speed-caller", demo=True)
    speed_process = processes[-1]
    connect_identity(speed_base, speed_token, "client")
    request(speed_base, "/api/join", {"invitation": diagnostics_host["invitation"]}, speed_token)
    wait_ui(diagnostics_process, lambda: user32.IsWindowEnabled(fixture_control(diagnostics_process, main_window, 260)), "speed entry after pairing")
    click_fixture(diagnostics_process, main_window, 260)
    speed_class = desktop_class + ".SpeedTest"
    speed_window = wait_ui(diagnostics_process, lambda: fixture_window(diagnostics_process, speed_class), "independent speed window")
    wait_ui(diagnostics_process, lambda: user32.IsWindowEnabled(fixture_control(diagnostics_process, speed_window, 261)), "speed target readiness")
    assert request(diagnostics_base, "/api/proxy/speed-test", token=diagnostics_token)["job"] is None, "Opening started traffic"
    assert not user32.IsWindowEnabled(fixture_control(diagnostics_process, speed_window, 262)), "B must choose a target first"
    target = fixture_control(diagnostics_process, speed_window, 261)
    fixture_message(diagnostics_process, target, 0x014E, 0)  # CB_SETCURSEL
    fixture_message(diagnostics_process, speed_window, 0x0111, (1 << 16) | 261, target)  # CBN_SELCHANGE
    click_fixture(diagnostics_process, speed_window, 262)
    wait_status(diagnostics_base, diagnostics_token, lambda state: state["proxy"]["speedTest"]["job"] is not None and state["proxy"]["speedTest"]["job"]["state"] == "completed", "native speed test did not finish")
    result = request(diagnostics_base, "/api/proxy/speed-test", token=diagnostics_token)["job"]["report"]
    assert result["completed"] and result["download"]["receivedBytes"] > 0 and result["upload"]["receivedBytes"] > 0
    wait_ui(diagnostics_process, lambda: "Mbps" in fixture_text(diagnostics_process, speed_window, 266), "native download metric")
    wait_ui(diagnostics_process, lambda: "ms" in fixture_text(diagnostics_process, speed_window, 270), "native RTT metric")
    click_fixture(diagnostics_process, speed_window, 265)
    assert not user32.IsWindow(speed_window)
    stop(speed_base, speed_token, speed_process)
    print("PASS: isolated speed window is connection gated, requires B target selection, measures both real directions and RTT, and closes independently.", flush=True)
    stop(diagnostics_base, diagnostics_token, diagnostics_process)
    assert diagnostics_process.returncode == 0, "Exiting with a diagnostics window failed"
    print("PASS: namespaced desktop diagnostics shows unavailable counters, updates capture time automatically, supports manual refresh, stays closed across its refresh interval and exits cleanly.", flush=True)
    # Reuse the extracted runtime and shut down as soon as its API appears,
    # before the native desktop necessarily finishes its own bootstrap poll.
    for _ in range(3):
        quick_base, quick_token = start("embedded", port=model_port(base), poll_interval=0.005, wait_identity=False, desktop_mode=True)
        quick_process = processes[-1]
        request(quick_base, "/api/shutdown", {}, quick_token)
        assert quick_process.wait(timeout=5) == 0, "A graceful early shutdown returned a failure"
        wait_stopped(quick_base)
    print("PASS: three cached starts exit promptly when API shutdown races native desktop initialization.", flush=True)
    # Killing the desktop must close its Windows job, including the local API and network helper.
    crash_base, _ = start("job-cleanup", desktop_mode=True)
    request(crash_base, "/api/tailscale", token=clients[-1][1])
    engine_pid = request(crash_base, "/health")["parentPid"]
    old_engine = kernel32.OpenProcess(0x00100000, False, engine_pid)  # SYNCHRONIZE
    if not old_engine:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        processes[-1].kill()
        processes[-1].wait(timeout=10)
        while True:
            takeover_port = available_port_pair()
            if takeover_port != model_port(crash_base):
                break
        takeover_base, takeover_token = start("job-takeover", port=takeover_port, desktop_mode=True)
        assert kernel32.WaitForSingleObject(old_engine, 0) == 0, "Different-port/profile takeover started before the previous engine signaled"
        stop(takeover_base, takeover_token, processes[-1])
    finally:
        kernel32.CloseHandle(old_engine)
    closed = False
    for _ in range(60):
        try:
            request(crash_base, "/health")
        except Exception:
            closed = True
            break
        time.sleep(0.1)
    assert closed, "API worker survived after its desktop process was killed"
    print("PASS: desktop crash handoff across port/profile waits for the old engine process to finish.", flush=True)
    a, token_a = start("caller", demo=True)
    process_a = processes[-1]
    a2, token_a2 = start("caller-2", demo=True)
    process_a2 = processes[-1]
    b, token_b = start("host", demo=True)
    process_b = processes[-1]
    for endpoint, credential, role in ((a, token_a, "client"), (a2, token_a2, "client"), (b, token_b, "host")):
        initial = request(endpoint, "/api/status", token=credential)
        assert initial["identity"]["role"] is None and not initial["capabilities"]["model"] and not initial["capabilities"]["proxy"], initial
        connect_identity(endpoint, credential, role)
    host = request(b, "/api/host", {"tailscaleIp": "127.0.0.1", "bridgePort": 0}, token_b)
    assert host["capabilities"]["model"] and host["capabilities"]["proxy"] and not host["model"]["enabled"], host
    configured_host = request(b, "/api/model", {"enabled": True, "workspace": str(root), "profile": "read"}, token_b)
    assert configured_host["model"]["enabled"] and configured_host["model"]["configured"], configured_host
    connected = request(a, "/api/join", {"invitation": host["invitation"]}, token_a)
    assert connected["online"] and connected["demo"]
    assert request(a2, "/api/join", {"invitation": host["invitation"]}, token_a2)["online"]
    wait_all_connected(a, token_a, a2, token_a2, b, token_b)
    enable_model_api(a, token_a)
    enable_model_api(a2, token_a2)
    listing = request(a, "/v1/models", token=token_a)
    advertised = request(b, "/api/status", token=token_b)["model"]["models"]
    assert listing["data"] and {item["id"] for item in listing["data"]} == {item["id"] for item in advertised}
    model_id = listing["data"][0]["id"]
    messages = [{"role": "user", "content": "[tool] Read the A-only fixture."}]
    tools = [{"type": "function", "function": {"name": "read_local_fixture", "description": "Read a file on A.", "parameters": {"type": "object", "properties": {}, "additionalProperties": False}}}]
    model_first = request(a, "/v1/chat/completions", {"model": model_id, "messages": messages, "tools": tools, "tool_choice": "required", "stream": False}, token_a)
    assert model_first["model"] == model_id, model_first
    model_message = model_first["choices"][0]["message"]
    assert model_first["choices"][0]["finish_reason"] == "tool_calls", model_first
    model_call = model_message["tool_calls"][0]
    assert model_call["function"]["name"] == "read_local_fixture"
    assert json.loads(model_call["function"]["arguments"]) == {}
    local_fixture = directory / "caller/harness-only.txt"
    local_fixture.write_text("EXE-HARNESS-A-ONLY-RESULT", encoding="utf-8")
    messages += [model_message, {"role": "tool", "tool_call_id": model_call["id"], "content": local_fixture.read_text(encoding="utf-8")}]
    model_final = request(a, "/v1/chat/completions", {"model": model_id, "messages": messages, "tools": tools, "stream": False}, token_a)
    assert model_final["choices"][0]["finish_reason"] == "stop", model_final
    assert "EXE-HARNESS-A-ONLY-RESULT" in model_final["choices"][0]["message"]["content"]
    print("PASS: packaged model discovery and structured tool round-trip; Harness fixture runs on A and returns its result to B.", flush=True)
    result = request(a, "/v1/run", {"prompt": "single executable end-to-end test", "stream": False}, token_a)
    assert result["success"], result
    assert "single executable end-to-end test" in result["result"]["result"]
    stolen = request(a2, "/v1/run", {"prompt": "must not resume another A", "sessionId": result["sessionId"], "stream": False}, token_a2)
    assert not stolen["success"] and any("不属于当前" in error["message"] for error in stolen["errors"]), stolen
    assert request(a, "/api/status", token=token_a)["pairing"]["saved"]
    assert request(a2, "/api/status", token=token_a2)["pairing"]["saved"]
    assert request(b, "/api/status", token=token_b)["pairing"]["saved"]
    for name in ("caller", "caller-2", "host"):
        blob = (directory / name / "pairing-demo.dat").read_bytes()
        assert host["invitation"].encode() not in blob, "Pairing credentials were stored as plaintext"
    print("PASS: standalone runtime, encrypted saved pairing, two simultaneous A clients and isolated Claude sessions.", flush=True)
    # A2 queues while A1 runs. Cancelling A1 starts only A2's own request.
    first = stream(a, token_a, "[slow] A1-private-prompt")
    first_id = first.headers["X-Request-ID"]
    wait_host(b, token_b, connected=2, queued=0, active=1)
    second = stream(a2, token_a2, "A2-private-prompt")
    wait_host(b, token_b, connected=2, queued=1, active=2)
    request(a, f"/v1/requests/{first_id}/cancel", {}, token_a)
    first_text = finish_stream(first)
    second_text = finish_stream(second)
    assert '"cancelled":true' in first_text and "A2-private-prompt" not in first_text, first_text
    assert second_text.index("event: queued") < second_text.index("event: started"), second_text
    assert "A2-private-prompt" in second_text and "A1-private-prompt" not in second_text, second_text
    assert '"cancelled":false' in second_text, second_text
    wait_host(b, token_b, connected=2, queued=0, active=0)
    # A queued request can be cancelled without stopping the other A's process.
    first = stream(a, token_a, "[slow] keep A1 running")
    first_id = first.headers["X-Request-ID"]
    wait_host(b, token_b, active=1, queued=0)
    second = stream(a2, token_a2, "A2 cancel while queued")
    second_id = second.headers["X-Request-ID"]
    wait_host(b, token_b, active=2, queued=1)
    request(a2, f"/v1/requests/{second_id}/cancel", {}, token_a2)
    cancelled = finish_stream(second)
    assert '"cancelled":true' in cancelled and "event: started" not in cancelled, cancelled
    wait_host(b, token_b, connected=2, queued=0, active=1)
    request(a, f"/v1/requests/{first_id}/cancel", {}, token_a)
    finish_stream(first)
    wait_host(b, token_b, active=0)
    print("PASS: B serializes concurrent callers, queue cancellation stays isolated, and responses reach their owning A.", flush=True)
    port_a, port_a2, port_b = model_port(a), model_port(a2), model_port(b)
    stop(a, token_a, process_a)
    stop(a2, token_a2, process_a2)
    stop(b, token_b, process_b)
    # Launch both A clients before B, with no new join/host requests.
    a, token_a = start("caller", demo=True, port=port_a)
    process_a = processes[-1]
    a2, token_a2 = start("caller-2", demo=True, port=port_a2)
    process_a2 = processes[-1]
    b, token_b = start("host", demo=True, port=port_b)
    process_b = processes[-1]
    wait_all_connected(a, token_a, a2, token_a2, b, token_b)
    enable_model_api(a, token_a)
    enable_model_api(a2, token_a2)
    restored = request(b, "/api/status", token=token_b)
    assert restored["invitation"] == host["invitation"], "B changed its pairing code on restart"
    assert restored["model"]["config"]["workspace"] == configured_host["model"]["config"]["workspace"]
    restored_model = request(a, "/v1/chat/completions", {"model": model_id, "messages": [{"role": "user", "content": "model after saved pairing restart"}], "stream": False}, token_a)
    assert "model after saved pairing restart" in restored_model["choices"][0]["message"]["content"]
    result = request(a, "/v1/run", {"prompt": "after automatic restart", "stream": False}, token_a)
    assert result["success"] and "after automatic restart" in result["result"]["result"]
    result_a2 = request(a2, "/v1/run", {"prompt": "second A after automatic restart", "stream": False}, token_a2)
    assert result_a2["success"] and "second A after automatic restart" in result_a2["result"]["result"]
    print("PASS: all three packaged engines restarted; both A clients launched first and reconnected to the saved B automatically.", flush=True)
    paused = request(a, "/api/pause", {}, token_a)
    assert paused["pairing"]["saved"] and paused["pairing"]["state"] == "paused"
    request(a, "/api/reconnect", {}, token_a)
    wait_all_connected(a, token_a, a2, token_a2, b, token_b)
    # A1's abrupt exit must leave A2 connected and its running process intact.
    survivor = stream(a2, token_a2, "[slow] A2 survives A1 exit")
    survivor_id = survivor.headers["X-Request-ID"]
    wait_host(b, token_b, active=1, queued=0)
    process_a.kill()
    process_a.wait(timeout=10)
    wait_stopped(a)
    wait_host(b, token_b, connected=1, active=1, queued=0)
    assert request(a2, "/api/status", token=token_a2)["online"]
    request(a2, f"/v1/requests/{survivor_id}/cancel", {}, token_a2)
    survivor_text = finish_stream(survivor)
    assert "PEER_DISCONNECTED" not in survivor_text and '"cancelled":true' in survivor_text, survivor_text
    a, token_a = start("caller", demo=True, port=port_a)
    process_a = processes[-1]
    wait_all_connected(a, token_a, a2, token_a2, b, token_b)
    forgotten = request(a, "/api/disconnect", {}, token_a)
    assert not forgotten["pairing"]["saved"]
    assert not (directory / "caller/pairing-demo.dat").exists()
    wait_host(b, token_b, connected=1, queued=0, active=0)
    assert request(a2, "/api/status", token=token_a2)["online"]
    stop(a, token_a, process_a)
    a, token_a = start("caller", demo=True, port=port_a)
    for _ in range(100):
        final = request(a, "/api/status", token=token_a)
        if final["pairing"]["state"] != "loading":
            break
        time.sleep(0.1)
    assert not final["pairing"]["saved"] and not final["online"] and final["identity"]["role"] == "client", final
    assert final["identity"]["locked"] and not final["capabilities"]["model"] and not final["capabilities"]["proxy"], final
    print("PASS: A1 exit/forgetting preserves A2's connection and task, while saved A1 recovers after a forced exit.", flush=True)

    # Test identity transitions in a separate isolated profile. An explicit
    # network-down is durable, preserves pairing/configuration, and does not
    # authorize reusing old business credentials after a role change.
    transition, transition_token = start("identity-transition", demo=True)
    transition_process = processes[-1]
    expect_error(transition, transition_token, "/api/host", {})
    connect_identity(transition, transition_token, "host")
    transition_host = request(transition, "/api/host", {"tailscaleIp": "127.0.0.1", "bridgePort": 0}, transition_token)
    request(transition, "/api/model", {"enabled": True, "workspace": str(root)}, transition_token)
    assert request(transition, "/api/proxy", {"sharing": True}, transition_token)["sharing"]
    expect_error(transition, transition_token, "/api/identity", {"role": "client"})
    down = request(transition, "/api/network/disconnect", {}, transition_token)
    assert not down["identity"]["desiredOnline"] and down["identity"]["canSwitchRole"] and not down["identity"]["locked"], down
    assert down["pairing"]["saved"] and down["model"]["enabled"] and down["capabilities"]["model"] and down["capabilities"]["proxy"], down
    expect_error(transition, transition_token, "/api/reconnect", {})
    transition_port = model_port(transition)
    stop(transition, transition_token, transition_process)
    transition, transition_token = start("identity-transition", demo=True, port=transition_port)
    transition_process = processes[-1]
    offline = request(transition, "/api/status", token=transition_token)
    assert offline["identity"]["role"] == "host" and not offline["identity"]["desiredOnline"] and offline["identity"]["canSwitchRole"], offline
    assert offline["pairing"]["saved"] and not offline["online"] and offline["model"]["enabled"], offline
    assert offline["model"]["config"]["workspace"] == configured_host["model"]["config"]["workspace"], offline
    expect_error(transition, transition_token, "/api/reconnect", {})
    request(transition, "/api/network/login", {}, transition_token)
    wait_status(transition, transition_token,
                lambda state: state.get("invitation") == transition_host["invitation"] and state["identity"]["locked"],
                "Saved host did not restore after explicit network login")
    request(transition, "/api/network/disconnect", {}, transition_token)
    changed = request(transition, "/api/identity", {"role": "client"}, transition_token)
    assert changed["identity"]["role"] == "client" and changed["identity"]["canSwitchRole"], changed
    assert not changed["pairing"]["saved"] and not changed["capabilities"]["model"] and not changed["capabilities"]["proxy"], changed
    assert not changed["model"]["enabled"] and changed["model"]["config"] is None, changed
    assert not request(transition, "/api/proxy", token=transition_token)["sharing"]
    expect_error(transition, transition_token, "/api/proxy", {"enabled": True})
    request(transition, "/api/network/login", {}, transition_token)
    expect_error(transition, transition_token, "/api/identity", {"role": "host"})
    request(transition, "/api/network/disconnect", {}, transition_token)
    stop(transition, transition_token, transition_process)
    print("PASS: explicit private-network down survives restart, keeps saved configuration, and role switching revokes old pairing/business authorization.", flush=True)
finally:
    for base, token in dict(clients).items():
        try:
            request(base, "/api/shutdown", {}, token)
        except Exception:
            pass
    for process in processes:
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    temporary.cleanup()
