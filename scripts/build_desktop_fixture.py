"""Build the real desktop in a source-only, isolated single-instance namespace.

The release EXE has no runtime namespace override. This compile-time fixture
embeds the same engine resources and uses the production Application code.
"""
import argparse
import os
from pathlib import Path
import re
import subprocess
import uuid
from build_support import ROOT
from test_support import checked_fixture_path


def build_fixture(name=None, output_directory=None, source=None):
    name = name or "smoke-" + uuid.uuid4().hex
    if not re.fullmatch(r"[A-Za-z0-9-]+", name):
        raise ValueError("The fixture name must contain only letters, numbers and hyphens")
    compiler = ROOT / ".tools/w64devkit/bin/g++.exe"
    resources = ROOT / "bin/desktop-build/resources.o"
    if not resources.is_file():
        raise FileNotFoundError("Build the Windows release first to prepare its embedded resources")
    directory = (ROOT / "bin/desktop-fixture" / name if output_directory is None
                 else checked_fixture_path(output_directory))
    target = directory / "ClaudeBridge-DesktopFixture.exe"
    target.parent.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["PATH"] = str(compiler.parent) + os.pathsep + env.get("PATH", "")
    subprocess.run([str(compiler), "-std=c++20", "-O2", "-s", "-static", "-static-libgcc", "-static-libstdc++",
                    "-municode", "-mwindows", "-Wall", "-Wextra", "-Wno-missing-field-initializers",
                    f'-DBRIDGE_DESKTOP_TEST_NAMESPACE=L"{name}"', "-I", str(resources.parent),
                    str(source or ROOT / "native/desktop/main.cpp"), str(resources), "-o", str(target),
                    "-lwinhttp", "-lcomctl32", "-lshell32", "-lole32", "-luuid", "-lgdi32",
                    "-lbcrypt", "-luser32", "-ladvapi32", "-luxtheme"],
                   env=env, check=True, timeout=120, creationflags=subprocess.CREATE_NO_WINDOW)
    return target


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", help="Compile-time fixture namespace, unrelated to production")
    print(build_fixture(parser.parse_args().name))
