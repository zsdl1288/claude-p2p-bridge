"""Exercise the real native RPC, pairing, subscriptions and Mihomo over loopback."""
import os
import shutil
import subprocess
from build_support import ROOT, go_environment
from test_support import TemporaryTestDirectory


def main():
    node = shutil.which("node")
    if not node:
        raise SystemExit("Node.js is required")
    temporary = TemporaryTestDirectory("native-proxy-smoke-")
    try:
        fixture = temporary.path / "native-proxy-fixture.exe"
        env = go_environment()
        subprocess.run([str(ROOT / ".tools/go/bin/go.exe"), "test", "-c", "-o", str(fixture), "./netcore"],
                       cwd=ROOT / "native", env=env, check=True, timeout=180)
        env["BRIDGE_NATIVE_RPC_FIXTURE"] = "1"
        subprocess.run([node, str(ROOT / "scripts/smoke-native-proxy.mjs"), str(fixture)],
                       cwd=ROOT, env=env, check=True, timeout=390)
    finally:
        temporary.cleanup()


if __name__ == "__main__":
    main()
