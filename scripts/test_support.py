"""Disposable fixtures shared by local Windows checks; never use live profiles."""
import atexit
from functools import lru_cache
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import stat
import subprocess
import tempfile
import time


ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / ".bridge"


def management_port(port):
    return 65534 if port == 65535 else port + 1


@lru_cache(maxsize=1)
def _dynamic_tcp_range():
    if os.name != "nt":
        return None
    result = subprocess.run(
        ["netsh", "interface", "ipv4", "show", "dynamicport", "tcp"],
        check=True, capture_output=True, timeout=10,
        creationflags=subprocess.CREATE_NO_WINDOW)
    # Read the two numeric fields without depending on the Windows UI language.
    values = [int(value) for value in re.findall(rb":\s*(\d+)\s*$", result.stdout, re.MULTILINE)]
    if len(values) != 2 or not (1 <= values[0] <= 65535 and 1 <= values[1] <= 65536 - values[0]):
        raise RuntimeError("Cannot determine the Windows TCP dynamic port range")
    return values[0], values[0] + values[1] - 1


def available_port_pair():
    """Probe both listeners outside Windows' client-port range.

    An HTTP readiness probe can otherwise connect to itself before the child
    binds its server, leaving TIME_WAIT on that port and masking startup errors.
    The child still binds its own sockets; an unrelated process can win that
    normal allocation race, so callers retain their bounded startup checks.
    """
    dynamic = _dynamic_tcp_range()
    candidates = [port for port in range(1024, 65535)
                  if not dynamic or not any(dynamic[0] <= value <= dynamic[1] for value in (port, port + 1))]
    if not candidates:
        raise RuntimeError("No loopback port pair outside the TCP dynamic range")
    # Sample the valid space itself. Skipping a large excluded interval after
    # choosing a start would send most concurrent fixtures to the same boundary.
    start = secrets.randbelow(len(candidates))
    for offset in range(len(candidates)):
        port = candidates[(start + offset) % len(candidates)]
        with socket.socket() as model, socket.socket() as management:
            try:
                model.bind(("127.0.0.1", port))
                management.bind(("127.0.0.1", port + 1))
            except OSError:
                continue
            return port
    raise RuntimeError("No unused loopback port pair outside the TCP dynamic range")


def _linked(path):
    return path.is_symlink() or (path.exists() and
        getattr(path.lstat(), "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))


def checked_fixture_path(path):
    """Require an ordinary path below this workspace's isolated fixture root."""
    target = Path(path).absolute()
    if target == FIXTURES or not target.is_relative_to(FIXTURES):
        raise ValueError(f"Test fixture must be inside {FIXTURES}: {target}")
    for entry in (target, *target.parents):
        if _linked(entry):
            raise ValueError(f"Linked test fixture path is not allowed: {entry}")
        if entry == ROOT:
            break
    if target.resolve() != target:
        raise ValueError(f"Test fixture path resolves outside its expected location: {target}")
    return target


class TemporaryTestDirectory:
    """Remove only this invocation's fixture, after children have been stopped."""
    def __init__(self, prefix):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]*-", prefix):
            raise ValueError("A test fixture prefix must contain letters, numbers and hyphens")
        FIXTURES.mkdir(exist_ok=True)
        checked_fixture_path(FIXTURES / "fixture-path-check")
        self.path = checked_fixture_path(tempfile.mkdtemp(prefix=prefix, dir=FIXTURES))
        atexit.register(self.cleanup)

    def cleanup(self):
        target = checked_fixture_path(self.path)
        if target.exists():
            # Refuse unexpected links rather than traversing another profile.
            for base, directories, files in os.walk(target, followlinks=False):
                for name in (*directories, *files):
                    checked_fixture_path(Path(base) / name)
            for attempt in range(20):
                try:
                    shutil.rmtree(target)
                    break
                except PermissionError:
                    if attempt == 19:
                        raise
                    time.sleep(0.1)
        atexit.unregister(self.cleanup)

    def __enter__(self):
        return self.path

    def __exit__(self, *_):
        self.cleanup()
