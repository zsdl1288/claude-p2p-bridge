"""Python 3 standard-library client. Set P2P_BRIDGE_TOKEN before running."""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request


def read_events(response):
    """Read bounded SSE frames and require the bridge's terminal done event."""
    data = []
    frame_bytes = 0
    limit = 4 * 1024 * 1024
    while raw_line := response.readline(limit + 1):
        frame_bytes += len(raw_line)
        if frame_bytes > limit:
            raise ValueError("Bridge SSE event exceeds 4 MiB")
        line = raw_line.decode("utf-8").rstrip("\r\n")
        if not line:
            if data:
                event = json.loads("\n".join(data))
                if not isinstance(event, dict) or not isinstance(event.get("type"), str):
                    raise ValueError("Invalid bridge SSE event")
                yield event
                if event["type"] == "done":
                    return
            data = []
            frame_bytes = 0
        elif line.startswith("data:"):
            value = line[5:]
            data.append(value[1:] if value.startswith(" ") else value)
    raise ConnectionError("Bridge stream ended before the done event")


def run_bridge(prompt, *, base_url="http://127.0.0.1:3211", token, session_id=None):
    payload = {"prompt": prompt, "stream": True}
    if session_id:
        payload["sessionId"] = session_id
    request = urllib.request.Request(
        base_url.rstrip("/") + "/v1/run",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=3660) as response:
        yield from read_events(response)


def main():
    parser = argparse.ArgumentParser(description="Call Claude Code on your paired B computer")
    parser.add_argument("prompt")
    parser.add_argument("--url", default="http://127.0.0.1:3211")
    parser.add_argument("--session")
    args = parser.parse_args()
    token = os.environ.get("P2P_BRIDGE_TOKEN")
    if not token:
        parser.error("Set P2P_BRIDGE_TOKEN to A's local API token")
    printed = False
    failed = False
    try:
        for event in run_bridge(args.prompt, base_url=args.url, token=token, session_id=args.session):
            if event["type"] == "claude":
                payload = event["event"]
                delta = payload.get("event", {}).get("delta", {})
                if payload.get("type") == "stream_event" and delta.get("type") == "text_delta":
                    print(delta["text"], end="", flush=True)
                    printed = True
                if payload.get("type") == "result":
                    if not printed:
                        print(payload.get("result", ""), end="", flush=True)
                    print(f"\nsessionId: {payload.get('session_id', '')}", file=sys.stderr)
                    failed = failed or payload.get("is_error", False)
            elif event["type"] == "error":
                print(event["message"], file=sys.stderr)
                failed = True
            elif event["type"] == "stderr":
                print(event["text"], file=sys.stderr, end="")
            elif event["type"] == "done":
                failed = failed or event.get("cancelled", False) or event.get("exitCode") != 0
        print()
    except urllib.error.HTTPError as error:
        print(error.read().decode("utf-8"), file=sys.stderr)
        return 1
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 1 if failed else 0


if __name__ == "__main__":
    # Keep redirected output UTF-8 on Windows as well as the interactive console.
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    sys.exit(main())
