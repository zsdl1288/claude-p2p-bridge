"""Disposable fixtures shared by local Windows checks; never use live profiles."""
import atexit
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile
import time


ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / ".bridge"


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
