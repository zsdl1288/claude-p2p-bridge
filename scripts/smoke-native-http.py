"""Read small SSE events with the desktop's production WinHTTP helper."""
import http.server
import json
import os
from pathlib import Path
import queue
import socket
import subprocess
import threading
from test_support import TemporaryTestDirectory

root = Path(__file__).resolve().parent.parent
compiler = root / ".tools/w64devkit/bin/g++.exe"
temporary = TemporaryTestDirectory("native-http-")
target = temporary.path / "native-http-test.exe"
env = os.environ.copy()
env["PATH"] = str(compiler.parent) + os.pathsep + env.get("PATH", "")
subprocess.run([str(compiler), "-std=c++20", "-O2", "-static", "-static-libgcc", "-static-libstdc++",
                str(root / "test/native-http.cpp"), "-o", str(target), "-lwinhttp"], env=env, check=True, timeout=120,
               creationflags=subprocess.CREATE_NO_WINDOW)
release_response = threading.Event()
slow_started = threading.Event()
close_slow = threading.Event()


def event(data):
    return ("data: " + json.dumps(data, ensure_ascii=False) + "\n\n").encode()


class Fixture(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def chunk(self, payload):
        self.wfile.write(f"{len(payload):x}\r\n".encode() + payload + b"\r\n")
        self.wfile.flush()

    def do_GET(self):
        if self.path == "/model-error":
            body = json.dumps({"error": {"message": "B 模型服务未启用", "code": "unavailable"}}, ensure_ascii=False).encode()
            self.send_response(503)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/slow-action":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", "100")
            self.end_headers()
            self.wfile.write(b"{")
            self.wfile.flush()
            slow_started.set()
            close_slow.wait(timeout=5)
            self.close_connection = True
            self.connection.shutdown(socket.SHUT_RDWR)
            return
        if self.path == "/health":
            # Deliberately keep a non-JSON response unfinished. Startup only
            # needs the headers to identify an occupied local API port.
            self.send_response(503)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", "1000000")
            self.send_header("Connection", "close")
            self.close_connection = True
            self.end_headers()
            self.wfile.write(b"another local application")
            self.wfile.flush()
            release_response.wait(timeout=10)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Connection", "close")
        self.close_connection = True
        self.end_headers()
        payload = event({"type": "queued", "position": 1, "message": "正在排队"})
        split = payload.index("正".encode()) + 1  # Split inside a UTF-8 character.
        self.chunk(payload[:split])
        self.chunk(payload[split:])
        # The response cannot finish until Python sees the native queue event.
        if not release_response.wait(timeout=10):
            return
        self.chunk(event({"type": "started"}))
        self.chunk(event({"type": "done", "exitCode": 0}))
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
process = subprocess.Popen([str(target), str(server.server_port)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                           creationflags=subprocess.CREATE_NO_WINDOW)
lines = queue.Queue()
reader = threading.Thread(target=lambda: [lines.put(line.rstrip()) for line in process.stdout], daemon=True)
reader.start()
try:
    try:
        first = lines.get(timeout=3)
    except queue.Empty:
        if process.poll() is not None:
            raise AssertionError(f"Native fixture exited ({process.returncode}): {process.stderr.read()}")
        raise AssertionError("Native fixture did not emit its first SSE event")
    assert first == "queued", f"Unexpected first native event: {first}"
    assert process.poll() is None, "Native stream unexpectedly ended before the response was released"
    release_response.set()
    assert lines.get(timeout=2) == "started"
    assert lines.get(timeout=2) == "done"
    assert slow_started.wait(timeout=2), "Native long action did not reach the fixture"
    assert process.poll() is None, "Native long action unexpectedly completed before shutdown"
    close_slow.set()
    assert lines.get(timeout=3) == "closed", "Native long action was not interrupted by engine shutdown"
    assert process.wait(timeout=5) == 0, process.stderr.read()
    print("PASS: native occupied-port detection, SSE/model completion framing, identity access boundaries, login URL validation and long-action shutdown.", flush=True)
finally:
    release_response.set()
    close_slow.set()
    if process.poll() is None:
        process.kill()
        process.wait(timeout=5)
    reader.join(timeout=2)
    server.shutdown()
    server.server_close()
    temporary.cleanup()
