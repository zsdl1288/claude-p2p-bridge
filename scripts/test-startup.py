"""Compile and test native login startup against an isolated HKCU test key.

The real Windows Run key is never written. All copied-client fixtures live in
a temporary directory under .bridge and are removed after the test.
"""
from pathlib import Path
import os
import subprocess
from test_support import TemporaryTestDirectory


root = Path(__file__).resolve().parent.parent
compiler = root / ".tools/w64devkit/bin/g++.exe"
if os.name != "nt":
    raise SystemExit("This native startup test requires Windows.")
if not compiler.is_file():
    raise SystemExit("Compiler missing: run python scripts/bootstrap-tools.py first.")

with TemporaryTestDirectory("startup-test-") as directory:
    for source in [root / "native/desktop/startup.test.cpp", root / "test/startup-update.cpp"]:
        executable = directory / (source.stem + "-tests.exe")
        subprocess.run([
            str(compiler), "-std=c++20", "-O2", "-static", "-municode", "-Wall", "-Wextra",
            str(source), "-o", str(executable),
            "-ladvapi32", "-lwinhttp", "-lshell32", "-lbcrypt",
        ], cwd=root, check=True, timeout=120, creationflags=subprocess.CREATE_NO_WINDOW)
        result = subprocess.run([str(executable), directory / source.stem], cwd=root, timeout=30, capture_output=True, text=True, encoding='utf-8',
                                creationflags=subprocess.CREATE_NO_WINDOW)
        if result.stdout:
            print(result.stdout, end='')
        if result.stderr:
            print(result.stderr, end='')
        result.check_returncode()
