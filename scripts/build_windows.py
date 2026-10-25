"""Build one portable EXE: native C++ UI + static runtime + embedded bridge engine."""
import argparse
import hashlib
import json
import os
import re
import struct
import subprocess
import sys
import zlib
from build_support import ROOT as root, VERSION as version, atomic_write, go_environment, source_manifest, verify_source_version, write_manifest

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--diagnostics', action='store_true', help='Build a clearly marked local diagnostics EXE in release/diagnostics')
parser.add_argument('--diagnostic-label', help='Local build label, in the form local-diagnostics-YYYYMMDD.N')
options = parser.parse_args()
if options.diagnostic_label is not None and not options.diagnostics:
    parser.error('--diagnostic-label requires --diagnostics')
diagnostic_label = (options.diagnostic_label if options.diagnostic_label is not None else 'local-diagnostics-20261020.1') if options.diagnostics else None
if diagnostic_label is not None and not re.fullmatch(r'local-diagnostics-[0-9]{8}\.[1-9][0-9]{0,5}', diagnostic_label, re.ASCII):
    parser.error('--diagnostic-label must use local-diagnostics-YYYYMMDD.N with a positive build number of at most six digits')

# Select every output before snapshotting sources. A local diagnostics build
# must never replace a release executable, helper or desktop build directory.
build = root / 'bin/desktop-build-diagnostics' / diagnostic_label if diagnostic_label else root / 'bin/desktop-build'
release = root / 'release/diagnostics' if diagnostic_label else root / 'release'
target_name = f'ClaudeBridge-{version}-{diagnostic_label}-windows-x64.exe' if diagnostic_label else f'ClaudeBridge-{version}-windows-x64.exe'
target = release / target_name
helper = build / 'bridge-net.exe' if diagnostic_label else root / 'bin/bridge-net.exe'
engine = build / 'bridge-engine.exe' if diagnostic_label else root / 'bin/bridge-engine.exe'

go = root / ".tools/go/bin/go.exe"
compiler = root / ".tools/w64devkit/bin/g++.exe"
windres = compiler.with_name("windres.exe")
if not all(path.is_file() for path in [go, compiler, windres]):
    raise SystemExit("Run python scripts/bootstrap-tools.py to prepare portable C++/Go tools.")

env = go_environment(tcp_diagnostics=options.diagnostics)
env["PATH"] = str(compiler.parent) + os.pathsep + env.get("PATH", "")
build.mkdir(parents=True, exist_ok=True)
release.mkdir(parents=True, exist_ok=True)
manifest = build / 'app.manifest'
write_manifest(manifest)


def run(args, cwd=root):
    subprocess.run([str(arg) for arg in args], cwd=cwd, env=env, check=True)


verify_source_version(root, version)
initial_sources = source_manifest()
if env.get("BRIDGE_TCP_RECOVERY_BUILD") == "1":
    run([go, "test", "gvisor.dev/gvisor/pkg/tcpip/transport/tcp", "-run", "^TestAudit", "-count=1"], root / "native")
run([go, "build", "-trimpath", "-ldflags=-s -w", "-o", helper, "./cmd/bridge-net"], root / "native")
run([sys.executable, root / "scripts/prepare-windows.py"])
build_sources = source_manifest()
# Third-party notices are the only source asset generated during preparation.
if {k: v for k, v in initial_sources.items() if k != 'public/licenses.txt'} != {k: v for k, v in build_sources.items() if k != 'public/licenses.txt'}:
    raise RuntimeError('Sources changed during preparation; finish editing and rebuild')
run([go, "build", "-trimpath", f"-ldflags=-s -w -H=windowsgui -X main.version={version}", "-o", engine, "./cmd/bridge"], root / "native")
engine_hash = hashlib.sha256(engine.read_bytes()).hexdigest()
build_config = f'#pragma once\n#define BRIDGE_VERSION "{version}"\n#define ENGINE_SHA256 "{engine_hash}"\n'
if diagnostic_label:
    build_config += f'#define BRIDGE_DIAGNOSTICS_BUILD 1\n#define BRIDGE_BUILD_LABEL "{diagnostic_label}"\n'
(build / "build_config.hpp").write_text(build_config, encoding="utf-8")

# Original geometric icon. PNG-in-ICO is supported by Windows 10/11.
def rounded(x, y, x0, y0, x1, y1, radius):
    cx = min(max(x, x0 + radius), x1 - radius)
    cy = min(max(y, y0 + radius), y1 - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2


pixels = bytearray()
for y in range(64):
    pixels.append(0)
    for x in range(64):
        samples = []
        for sy in (0.125, 0.375, 0.625, 0.875):
            for sx in (0.125, 0.375, 0.625, 0.875):
                px, py = x + sx, y + sy
                color = (23, 30, 42, 255) if rounded(px, py, 1, 1, 63, 63, 13) else (0, 0, 0, 0)
                for box, tint in [((14, 14, 38, 38), (245, 246, 249, 255)), ((27, 27, 51, 51), (210, 119, 85, 255))]:
                    a, b, c, d = box
                    if rounded(px, py, a, b, c, d, 5) and not rounded(px, py, a + 4, b + 4, c - 4, d - 4, 2):
                        color = tint
                samples.append(color)
        pixels.extend(round(sum(sample[channel] for sample in samples) / 16) for channel in range(4))


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 64, 64, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b"")
icon = build / "bridge.ico"
icon.write_bytes(struct.pack("<HHH", 0, 1, 1) + struct.pack("<BBBBHHII", 64, 64, 0, 0, 1, 32, len(png), 22) + png)


def rc_path(path):
    return str(path).replace("\\", "\\\\")


parts = version.split(".") + ["0"]
description = 'Claude Bridge local diagnostics desktop' if diagnostic_label else 'Claude Bridge native C++ desktop'
diagnostic_comment = f'   VALUE "Comments", "Local diagnostics build: {diagnostic_label}"\n' if diagnostic_label else ''
rc = build / "desktop.rc"
rc.write_text(f'''#include <windows.h>
101 ICON "{rc_path(icon)}"
102 RCDATA "{rc_path(engine)}"
1 RT_MANIFEST "{rc_path(manifest)}"
1 VERSIONINFO
 FILEVERSION {','.join(parts)}
 PRODUCTVERSION {','.join(parts)}
 FILEFLAGSMASK 0x3fL
 FILEFLAGS {2 if diagnostic_label else 0}
 FILEOS 0x40004L
 FILETYPE 1
BEGIN
 BLOCK "StringFileInfo"
 BEGIN
  BLOCK "040904b0"
  BEGIN
   VALUE "FileDescription", "{description}"
   VALUE "FileVersion", "{version}"
   VALUE "ProductName", "Claude Bridge"
   VALUE "ProductVersion", "{version}"
{diagnostic_comment}  END
 END
 BLOCK "VarFileInfo"
 BEGIN
  VALUE "Translation", 0x409, 1200
 END
END
''', encoding="utf-8")
run([windres, "-i", rc, "-o", build / "resources.o"])
temporary = build / "ClaudeBridge-next.exe"
try:
    run([compiler, "-std=c++20", "-O2", "-s", "-static", "-static-libgcc", "-static-libstdc++", "-municode", "-mwindows",
         "-Wall", "-Wextra", "-Wno-missing-field-initializers", "-I", build,
         root / "native/desktop/main.cpp", build / "resources.o", "-o", temporary,
         "-lwinhttp", "-lcomctl32", "-lshell32", "-lole32", "-luuid", "-lgdi32", "-lbcrypt", "-luser32", "-ladvapi32", "-luxtheme", "-lversion"])
    if source_manifest() != build_sources:
        raise RuntimeError('Sources changed during compilation; finish editing and rebuild')
    # A failed build or a running release must leave the last usable EXE intact.
    os.replace(temporary, target)
finally:
    temporary.unlink(missing_ok=True)
digest = hashlib.sha256(target.read_bytes()).hexdigest()
atomic_write(target.with_suffix('.sha256.txt'), f'{digest}  {target.name}\n'.encode('ascii'))
build_record = {
    'v': 1, 'version': version, 'executable': target.name, 'sha256': digest,
    'sources': build_sources
}
if env.get('BRIDGE_TCP_RECOVERY_BUILD') == '1':
    policy_file = root / 'native/_tcp_recovery/policy.json'
    policy = json.loads(policy_file.read_text(encoding='utf-8'))
    build_record.update(tcpRecoveryApplied=True,
                        tcpRecoveryModuleVersion=policy['moduleVersion'],
                        tcpRecoveryPolicySha256=hashlib.sha256(policy_file.read_bytes()).hexdigest())
if diagnostic_label:
    build_record.update(diagnostics=True, buildLabel=diagnostic_label)
atomic_write(target.with_suffix('.build.json'), json.dumps(build_record, ensure_ascii=False, indent=2).encode('utf-8'))
print(f"{target} ({target.stat().st_size} bytes)\nSHA256: {digest}")
