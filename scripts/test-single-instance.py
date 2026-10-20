"""Verify Windows single-instance ownership without touching real user data."""
import os
import argparse
from pathlib import Path
import queue
import socket
import subprocess
import threading
import uuid
from build_support import ROOT, VERSION
from test_support import TemporaryTestDirectory, available_port_pair


def main(skip_release=False):
    if os.name != "nt":
        raise SystemExit("This fixture requires Windows")
    compiler = ROOT / ".tools/w64devkit/bin/g++.exe"
    temporary = TemporaryTestDirectory("single-instance-")
    target = temporary.path / "single-instance-test.exe"
    env = os.environ.copy()
    env["PATH"] = str(compiler.parent) + os.pathsep + env.get("PATH", "")
    subprocess.run([str(compiler), "-std=c++20", "-O2", "-static", "-static-libgcc", "-static-libstdc++", "-municode",
                    "-Wall", "-Wextra", str(ROOT / "test/single-instance.cpp"), "-o", str(target), "-ladvapi32", "-luser32"],
                   env=env, check=True, timeout=120, creationflags=subprocess.CREATE_NO_WINDOW)
    children = []
    assert subprocess.check_output([str(target), "--job-exit-test"], text=True, timeout=15,
                                   creationflags=subprocess.CREATE_NO_WINDOW).strip() == "job-empty"
    with temporary as directory:
        def launch(name, mode, delay=0):
            quit_file = Path(directory) / (uuid.uuid4().hex + ".quit")
            process = subprocess.Popen([str(target), name, mode, str(quit_file), str(delay)], stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE, text=True, creationflags=subprocess.CREATE_NO_WINDOW)
            children.append(process)
            lines = queue.Queue()
            threading.Thread(target=lambda: [lines.put(line.strip()) for line in process.stdout], daemon=True).start()
            return process, lines, quit_file

        def line(child, expected):
            process, lines, _ = child
            try:
                value = lines.get(timeout=7)
            except queue.Empty:
                raise AssertionError(f"Expected {expected}; process exit={process.poll()}")
            assert value == expected, (expected, value)

        def finish(child):
            process, _, quit_file = child
            quit_file.touch()
            assert process.wait(timeout=7) == 0, process.stderr.read()

        try:
            lifecycle = launch(uuid.uuid4().hex, "lifecycle")
            line(lifecycle, "mutex-released"); assert lifecycle[0].wait(timeout=7) == 0
            name = uuid.uuid4().hex
            owner = launch(name, "hold", 500)
            line(owner, "owner")
            duplicate = launch(name, "probe")
            line(owner, "window"); line(duplicate, "secondary"); line(owner, "restore")
            assert duplicate[0].wait(timeout=7) == 0
            quiet = launch(name, "minimized")
            line(quiet, "secondary"); assert quiet[0].wait(timeout=7) == 0
            try:
                unexpected = owner[1].get(timeout=0.2)
            except queue.Empty:
                pass
            else:
                raise AssertionError(f"Minimized duplicate unexpectedly activated the owner: {unexpected}")
            finish(owner)
            replacement = launch(name, "probe"); line(replacement, "owner"); assert replacement[0].wait(timeout=7) == 0

            for mode in ("early", "crash"):
                name = uuid.uuid4().hex
                first = launch(name, mode, 500); line(first, "owner")
                waiting = launch(name, "probe")
                line(waiting, "owner"); assert waiting[0].wait(timeout=7) == 0
                assert first[0].wait(timeout=7) == (9 if mode == "crash" else 0)

            name = uuid.uuid4().hex
            legacy = launch(name, "legacy"); line(legacy, "window")
            foreign = launch(name, "foreign"); line(foreign, "foreign-filtered"); assert foreign[0].wait(timeout=7) == 0
            newer = launch(name, "probe"); line(newer, "secondary"); line(legacy, "restore")
            assert newer[0].wait(timeout=7) == 0
            finish(legacy)

            # A same-user lock with restricted access must still permit window
            # restoration, and an owner exiting before its HWND allows takeover.
            name = uuid.uuid4().hex
            restricted = launch(name, "restricted"); line(restricted, "owner"); line(restricted, "window")
            duplicate = launch(name, "probe"); line(duplicate, "secondary"); line(restricted, "restore")
            assert duplicate[0].wait(timeout=7) == 0
            finish(restricted)
            for mode in ("restricted-early", "restricted-crash"):
                name = uuid.uuid4().hex
                first = launch(name, mode, 500); line(first, "owner")
                waiting = launch(name, "probe")
                line(waiting, "owner"); assert waiting[0].wait(timeout=7) == 0
                assert first[0].wait(timeout=7) == (9 if mode.endswith("crash") else 0)

            # If a real release/older desktop already exists, test only a quiet
            # secondary launch. Never stop, activate, query its API or edit it.
            pid = int(subprocess.check_output([str(target), "--find-production"], text=True,
                                              creationflags=subprocess.CREATE_NO_WINDOW).strip())
            release = ROOT / f"release/ClaudeBridge-{VERSION}-windows-x64.exe"
            if not skip_release and pid and release.is_file():
                isolated = Path(directory) / "release-secondary"
                port = available_port_pair()
                secondary = subprocess.run([str(release), "--minimized", "--port", str(port), "--data-dir", str(isolated)],
                                           timeout=15, creationflags=subprocess.CREATE_NO_WINDOW)
                assert secondary.returncode == 0 and not isolated.exists(), "Release secondary launch wrote data or failed to exit"
                with socket.socket() as probe:
                    probe.settimeout(0.2)
                    assert probe.connect_ex(("127.0.0.1", port)) != 0, "Release secondary launch started another engine"
                print("PASS: release secondary launch respected the existing desktop across port/profile/version without activating or writing it.", flush=True)
            else:
                print("SKIP: real-release secondary test requires an already-running desktop and a built release.", flush=True)
            print("PASS: user-SID mutex, concurrent startup, quiet/active duplicates, legacy discovery, restricted-lock restoration/takeover, full job shutdown, named-job crash handoff/fail-closed access, early exit and crash takeover.", flush=True)
        finally:
            for process in children:
                if process.poll() is None:
                    process.kill(); process.wait(timeout=5)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-release-check", action="store_true", help="Run isolated source fixtures before rebuilding the release")
    main(parser.parse_args().skip_release_check)
