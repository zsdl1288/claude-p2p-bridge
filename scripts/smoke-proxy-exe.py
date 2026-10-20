"""Smoke-test the packaged Clash engine using isolated local demo instances.

No public target, TUN, system proxy, route, firewall change, or UAC operation is used.
"""
from pathlib import Path
import http.client
import json
import os
import socket
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from build_support import ROOT, VERSION
from test_support import TemporaryTestDirectory, available_port_pair, management_port


EXECUTABLE = ROOT / "bin/bridge-engine.exe"
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def request(base, route, body=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if route == "/api/bootstrap":
        headers["X-Bridge-UI"] = "1"
    req = urllib.request.Request(
        base + route, data=None if body is None else json.dumps(body).encode(), headers=headers)
    with OPENER.open(req, timeout=5) as response:
        return json.load(response)


def wait_for(read, condition, description, timeout=25):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = read()
        if condition(value):
            return value
        time.sleep(0.1)
    raise TimeoutError(description)


def subscription(url):
    parsed = urllib.parse.urlparse(url)
    assert parsed.scheme == "http" and parsed.hostname == "127.0.0.1", "Subscription must be local"
    return request(f"http://127.0.0.1:{parsed.port}", parsed.path)


def receive_exact(connection, count):
    result = b""
    while len(result) < count:
        chunk = connection.recv(count - len(result))
        if not chunk:
            raise AssertionError("SOCKS connection ended before the expected response")
        result += chunk
    return result


def authenticated_socks(node):
    connection = socket.create_connection(("127.0.0.1", node["port"]), timeout=5)
    try:
        connection.sendall(b"\x05\x01\x02")
        assert receive_exact(connection, 2) == b"\x05\x02", "SOCKS must require authentication"
        username, password = node["username"].encode(), node["password"].encode()
        connection.sendall(bytes([1, len(username)]) + username + bytes([len(password)]) + password)
        assert receive_exact(connection, 2) == b"\x01\x00", "Local node credentials must work"
        return connection
    except Exception:
        connection.close()
        raise


def expect_error(base, token, route, body, code=409):
    try:
        request(base, route, body, token)
    except urllib.error.HTTPError as error:
        assert error.code == code, (route, error.code, error.read().decode("utf-8"))
    else:
        raise AssertionError(f"{route} unexpectedly accepted an invalid identity transition")


def connect_identity(base, token, role):
    state = request(base, "/api/identity", {"role": role}, token)
    assert state["identity"]["role"] == role and state["identity"]["canSwitchRole"], state
    state = request(base, "/api/network/login", {}, token)
    assert state["identity"]["desiredOnline"] and state["identity"]["locked"], state
    return state


def check_private_target_denied(node):
    # This listener proves a rejection happens before B attempts a private dial.
    with socket.socket() as target:
        target.bind(("127.0.0.1", 0))
        target.listen(1)
        target.settimeout(0.15)
        with authenticated_socks(node) as connection:
            connection.sendall(b"\x05\x01\x00\x01\x7f\x00\x00\x01" + target.getsockname()[1].to_bytes(2, "big"))
            reply = receive_exact(connection, 10)
            assert reply[0] == 5 and reply[1] != 0, "B must refuse private proxy targets"
        try:
            unexpected, _ = target.accept()
        except socket.timeout:
            pass
        else:
            unexpected.close()
            raise AssertionError("B unexpectedly dialed a private target")


def main():
    if os.name != "nt" or not EXECUTABLE.is_file():
        raise SystemExit("Build the Windows embedded engine before running this smoke test on Windows.")
    children, clients, model_ports = [], [], {}
    env = os.environ.copy()
    env["PATH"] = str(Path(os.environ["SystemRoot"]) / "System32")
    with TemporaryTestDirectory("proxy-exe-smoke-") as directory:
        def start(name, port=None):
            port = port or available_port_pair()
            base = f"http://127.0.0.1:{management_port(port)}"
            model_ports[base] = port
            process = subprocess.Popen(
                [str(EXECUTABLE), "--owned-engine", "--demo", "--no-browser", "--port", str(port),
                 "--data-dir", str(Path(directory) / name)],
                cwd=ROOT, env=env, creationflags=subprocess.CREATE_NO_WINDOW)
            children.append(process)
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError(f"{name} exited before startup (exit {process.returncode})")
                try:
                    assert request(base, "/health")["version"] == VERSION
                    token = request(base, "/api/bootstrap")["token"]
                    if token != (directory / name / "api-token").read_text(encoding="utf-8").strip():
                        raise ValueError("Readiness response belongs to another test profile")
                    clients.append((base, token))
                    initial = wait_for(lambda: request(base, "/api/status", token=token),
                                       lambda state: state["identity"]["loaded"], "Identity preferences did not load")
                    assert not initial["modelApi"]["enabled"] and not initial["modelApi"]["listening"], initial
                    return base, token, process
                except (OSError, ValueError, AssertionError, http.client.HTTPException):
                    time.sleep(0.1)
            raise TimeoutError(f"{name} did not start")

        try:
            b, token_b, _ = start("host")
            a, token_a, process_a = start("caller")
            connect_identity(b, token_b, "host")
            connect_identity(a, token_a, "client")
            host = request(b, "/api/host", {
                "tailscaleIp": "127.0.0.1", "bridgePort": 0}, token_b)
            assert host["capabilities"]["model"] and host["capabilities"]["proxy"] and not host["model"]["configured"], host
            assert request(a, "/api/join", {"invitation": host["invitation"]}, token_a)["online"]
            assert request(b, "/api/proxy", {"sharing": True}, token_b)["sharing"]
            assert request(a, "/api/proxy", {"enabled": True}, token_a)["enabled"]
            original = wait_for(lambda: request(a, "/api/proxy", token=token_a),
                                lambda state: state["state"] == "ready" and state["online"],
                                "A did not see B's shared exit")
            config = subscription(original["subscriptionUrl"])
            node = config["proxies"][0]
            assert node["type"] == "socks5" and node["server"] == "127.0.0.1"
            assert node["port"] == original["port"] and node["username"] and node["password"]
            assert node["udp"] is True and config["tun"]["enable"] is True
            assert config["tun"]["device"] == "ClaudeBridgeTun" and config["tun"]["strict-route"] is True
            group = config["proxy-groups"][0]
            assert group == {"name": "通过 B 上网", "type": "select", "proxies": [node["name"]]}
            assert config["rules"][-1] == "MATCH," + group["name"]
            assert all(resolver.endswith("#" + node["name"]) for resolver in config["dns"]["nameserver"])
            check_private_target_denied(node)
            assert len(original["devices"]) == 2 and sum(device["self"] for device in original["devices"]) == 1, original
            assert all(device["self"] or device["role"] == "host" for device in original["devices"]), original
            listed = request(b, "/api/proxy", token=token_b)
            assert len(listed["clients"]) == 1 and listed["clients"][0]["online"] and listed["clients"][0]["id"], listed
            for state in (original, listed):
                assert state["connectionLimit"] == 0 and state["sessionConnectionLimit"] == 0, "Packaged peers must not retain a fixed proxy connection limit"
            # A UDP association opens the real independent proxy channel but
            # does not contact any destination. Claude enable/disable must not
            # close it or change the subscription authorization.
            with authenticated_socks(node) as association:
                association.sendall(b"\x05\x03\x00\x01\x00\x00\x00\x00\x00\x00")
                assert receive_exact(association, 10)[:2] == b"\x05\x00", "UDP association was refused"
                wait_for(lambda: request(b, "/api/proxy", token=token_b),
                         lambda state: len(state["clients"]) == 1 and state["clients"][0]["usingProxy"],
                         "B did not mark the caller as actively using the proxy")
                request(b, "/api/model", {"enabled": True, "workspace": str(directory)}, token_b)
                wait_for(lambda: request(a, "/api/status", token=token_a),
                         lambda state: state["model"]["available"], "Claude model service did not become available")
                enabled_api = request(a, "/api/model-api", {"enabled": True}, token_a)
                assert enabled_api["modelApi"]["listening"], enabled_api
                disabled_api = request(a, "/api/model-api", {"enabled": False}, token_a)
                assert not disabled_api["modelApi"]["listening"], disabled_api
                request(b, "/api/model", {"enabled": False}, token_b)
                wait_for(lambda: request(a, "/api/status", token=token_a),
                         lambda state: not state["model"]["enabled"], "Claude disable did not reach A")
                association.settimeout(0.2)
                try:
                    unexpected = association.recv(1)
                except socket.timeout:
                    pass
                else:
                    raise AssertionError(f"Claude configuration closed or wrote to the proxy association: {unexpected!r}")
                independent = request(a, "/api/proxy", token=token_a)
                assert independent["online"] and independent["subscriptionUrl"] == original["subscriptionUrl"], independent
            print("PASS: identity-only pairing, packaged TUN/DNS subscription, private-target denial, device usage list and independent Claude/model API/proxy channels.", flush=True)

            request(b, "/api/pause", {}, token_b)
            blocked = wait_for(lambda: request(a, "/api/proxy", token=token_a),
                               lambda state: state["state"] == "blocked" and not state["online"],
                               "B pause did not block A's proxy")
            assert blocked["enabled"] and blocked["subscriptionUrl"] == original["subscriptionUrl"]
            assert subscription(blocked["subscriptionUrl"])["proxies"] == config["proxies"]
            with socket.create_connection(("127.0.0.1", original["port"]), timeout=5) as connection:
                try:
                    connection.sendall(b"\x05\x01\x02")
                    assert not connection.recv(2), "Offline local proxy must fail closed"
                except (ConnectionResetError, ConnectionAbortedError):
                    pass
            request(b, "/api/reconnect", {}, token_b)
            restored = wait_for(lambda: request(a, "/api/proxy", token=token_a),
                                lambda state: state["state"] == "ready" and state["online"],
                                "A failed to reconnect after B resumed")
            assert restored["subscriptionUrl"] == original["subscriptionUrl"]
            print("PASS: B pause fails closed, subscription remains importable, B resume automatically restores the exit.", flush=True)

            api_port = model_ports[a]
            request(a, "/api/shutdown", {}, token_a)
            assert process_a.wait(timeout=15) == 0
            a, token_a, process_a = start("caller", port=api_port)
            restarted = wait_for(lambda: request(a, "/api/proxy", token=token_a),
                                 lambda state: state["state"] == "ready" and state["online"],
                                 "A did not restore saved proxy and pairing after restart")
            assert restarted["enabled"] and restarted["port"] == original["port"]
            assert restarted["subscriptionUrl"] == original["subscriptionUrl"]
            assert subscription(restarted["subscriptionUrl"])["proxies"] == config["proxies"]
            print("PASS: packaged A engine restart restores pairing, enabled state, SOCKS port, credentials and subscription URL.", flush=True)

            down = request(a, "/api/network/disconnect", {}, token_a)
            assert down["identity"]["canSwitchRole"] and not down["identity"]["desiredOnline"], down
            assert down["pairing"]["saved"] and down["capabilities"]["proxy"], down
            expect_error(a, token_a, "/api/reconnect", {})
            request(a, "/api/shutdown", {}, token_a)
            assert process_a.wait(timeout=15) == 0
            a, token_a, _ = start("caller", port=api_port)
            offline = wait_for(lambda: request(a, "/api/status", token=token_a),
                               lambda state: state["identity"]["loaded"] and state["identity"]["canSwitchRole"],
                               "Explicit private-network down did not persist")
            assert not offline["identity"]["desiredOnline"] and offline["pairing"]["saved"] and not offline["online"], offline
            offline_proxy = wait_for(lambda: request(a, "/api/proxy", token=token_a),
                                     lambda state: state["enabled"] and state["state"] == "blocked" and not state["online"],
                                     "Offline restart failed to keep the configured proxy blocked")
            assert offline_proxy["subscriptionUrl"] == original["subscriptionUrl"] and offline_proxy["port"] == original["port"], offline_proxy
            for _ in range(3):
                time.sleep(0.2)
                assert not request(a, "/api/status", token=token_a)["online"], "Manual network-down unexpectedly reconnected"
            request(a, "/api/network/login", {}, token_a)
            wait_for(lambda: request(a, "/api/proxy", token=token_a),
                     lambda state: state["online"] and state["state"] == "ready", "Explicit reconnect did not restore saved proxy")
            expect_error(a, token_a, "/api/identity", {"role": "host"})
            request(a, "/api/network/disconnect", {}, token_a)
            changed = request(a, "/api/identity", {"role": "host"}, token_a)
            assert changed["identity"]["role"] == "host" and not changed["pairing"]["saved"] and not changed["capabilities"]["proxy"], changed
            revoked = request(a, "/api/proxy", token=token_a)
            assert not revoked["enabled"] and not revoked["sharing"] and not revoked["subscriptionUrl"], revoked
            try:
                subscription(original["subscriptionUrl"])
            except urllib.error.HTTPError as error:
                assert error.code == 503, "The old caller subscription must no longer return a working profile"
            else:
                raise AssertionError("Switching identity retained the old caller subscription authorization")
            print("PASS: explicit network-down survives restart without reconnecting; manual reconnect restores the saved exit; role switch revokes the old subscription and pairing.", flush=True)
        finally:
            for base, token in reversed(clients):
                try:
                    request(base, "/api/shutdown", {}, token)
                except (OSError, ValueError):
                    pass
            for process in children:
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


if __name__ == "__main__":
    main()
