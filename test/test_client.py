"""Regression tests for the public Python streaming client; no external service."""
import importlib.util
import io
import json
import http.server
import os
from pathlib import Path
import threading
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("bridge_example", Path(__file__).resolve().parents[1] / "examples/client.py")
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)


class ClientTests(unittest.TestCase):
    def test_loopback_request_bypasses_environment_proxy(self):
        received = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                received.append((self.server.is_proxy, self.headers.get("Authorization")))
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                self.send_response(502 if self.server.is_proxy else 200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                self.wfile.write(b'data: {"type":"done","exitCode":0}\n\n')

            def log_message(self, *_):
                pass

        servers = []
        try:
            for is_proxy in (False, True):
                server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
                server.is_proxy = is_proxy
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                servers.append((server, thread))
            local, proxy = (f"http://127.0.0.1:{server.server_port}" for server, _ in servers)
            with patch.dict(os.environ, {"http_proxy": proxy, "HTTP_PROXY": proxy,
                                          "no_proxy": "", "NO_PROXY": ""}), \
                    patch.object(client.urllib.request, "_opener", None):
                events = list(client.run_bridge("fixture", base_url=local, token="local-test"))
            self.assertEqual(events[-1]["exitCode"], 0)
            self.assertEqual(received, [(False, "Bearer local-test")])
        finally:
            for server, thread in servers:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_multiline_utf8_sse_and_completion(self):
        response = io.BytesIO(': keepalive\r\n\r\nevent: claude\r\ndata:{"type":"claude",\r\ndata: "event":{"text":"中文"}}\r\n\r\ndata: {"type":"done","exitCode":0}\r\n\r\n'.encode())
        events = list(client.read_events(response))
        self.assertEqual(events[0]["event"]["text"], "中文")
        self.assertEqual(events[1]["type"], "done")

    def test_truncated_invalid_and_oversized_streams_fail(self):
        for body in (b'', b'data: {"type":"claude"}\n\n', b'data: {"type":"done"}\n', b'data: []\n\n', b'data: nope\n\n', b'data: \xff\n\n', b'data: ' + b'a' * (4 * 1024 * 1024)):
            with self.subTest(body_length=len(body)):
                with self.assertRaises((OSError, ValueError)):
                    list(client.read_events(io.BytesIO(body)))

    def test_request_uses_local_token_and_session(self):
        with patch.object(client.urllib.request.OpenerDirector, "open", return_value=io.BytesIO(b'data: {"type":"done","exitCode":0}\n\n')) as opener:
            self.assertEqual(list(client.run_bridge("中文", token="local-test", session_id="own-session"))[0]["exitCode"], 0)
        request = opener.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:3211/v1/run")
        self.assertEqual(request.get_header("Authorization"), "Bearer local-test")
        self.assertEqual(json.loads(request.data)["sessionId"], "own-session")
        self.assertEqual(json.loads(request.data)["prompt"], "中文")


if __name__ == "__main__":
    unittest.main()
