"""Regression tests for the public Python streaming client; no external service."""
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("bridge_example", Path(__file__).resolve().parents[1] / "examples/client.py")
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)


class ClientTests(unittest.TestCase):
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
        with patch.object(client.urllib.request, "urlopen", return_value=io.BytesIO(b'data: {"type":"done","exitCode":0}\n\n')) as opener:
            self.assertEqual(list(client.run_bridge("中文", token="local-test", session_id="own-session"))[0]["exitCode"], 0)
        request = opener.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:3210/v1/run")
        self.assertEqual(request.get_header("Authorization"), "Bearer local-test")
        self.assertEqual(json.loads(request.data)["sessionId"], "own-session")
        self.assertEqual(json.loads(request.data)["prompt"], "中文")


if __name__ == "__main__":
    unittest.main()
