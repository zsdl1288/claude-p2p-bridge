"""Download verified portable build tools into this project, without installation."""
import hashlib
import subprocess
import urllib.request
import zipfile
from build_support import ROOT, TOOLS, go_environment

TOOLS.mkdir(exist_ok=True)


def download(url, path, expected=None):
    if not path.is_file() or (expected and hashlib.sha256(path.read_bytes()).hexdigest() != expected):
        request = urllib.request.Request(url, headers={"User-Agent": "ClaudeBridge-build"})
        with urllib.request.urlopen(request, timeout=120) as source, path.open("wb") as target:
            while chunk := source.read(1024 * 1024):
                target.write(chunk)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if expected and digest != expected:
        raise ValueError(f"Checksum mismatch: {path.name}")
    print(f"Verified {path.name}: {digest}", flush=True)


if not (TOOLS / "w64devkit/bin/g++.exe").is_file():
    archive = TOOLS / "w64devkit-x64-2.10.1.7z.exe"
    download("https://github.com/skeeto/w64devkit/releases/download/v2.10.1/" + archive.name,
             archive, "add1edf984ce4d473cfeb7c52e0ab38db73a855bba6c7f564d5e16648eb2896a")
    subprocess.run([str(archive), "-y", "-o" + str(TOOLS)], check=True,
                   creationflags=subprocess.CREATE_NO_WINDOW)

if not (TOOLS / "go/bin/go.exe").is_file():
    archive = TOOLS / "go1.27.2.windows-amd64.zip"
    download("https://go.dev/dl/" + archive.name, archive,
             "1314008898bd40df77af4b014f777f08873dbdfbcd3d92308728ee03304fe04f")
    with zipfile.ZipFile(archive) as source:
        for entry in source.infolist():
            destination = (TOOLS / entry.filename).resolve()
            if not destination.is_relative_to(TOOLS.resolve()):
                raise ValueError("Unsafe archive entry")
        source.extractall(TOOLS)

vendor = ROOT / "native/desktop/vendor"
vendor.mkdir(parents=True, exist_ok=True)
download("https://raw.githubusercontent.com/nlohmann/json/v3.12.0/single_include/nlohmann/json.hpp", vendor / "json.hpp",
         "aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63")
download("https://raw.githubusercontent.com/nlohmann/json/v3.12.0/LICENSE.MIT", vendor / "json-LICENSE.MIT",
         "46a65cffd1ea955132d95a8dd921640714a8d6b537d2e4e482d31145ae95b603")

env = go_environment(offline=False)
subprocess.run([str(TOOLS / "go/bin/go.exe"), "mod", "download"], cwd=ROOT / "native", env=env, check=True)
print("Portable C++ and Go build tools ready. No system settings changed.", flush=True)
