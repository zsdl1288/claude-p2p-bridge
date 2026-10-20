"""Create the executable's audited runtime payload, including third-party licenses."""
import json
from pathlib import Path
import shutil
import subprocess
import zipfile
from build_support import ROOT as root, VERSION as version, checked_path, go_environment, module_license_files, runtime_files

go = root / ".tools/go/bin/go.exe"
node_path = shutil.which('node')
if not node_path:
    raise SystemExit('Node.js is required on the build machine.')
node = Path(node_path)
env = go_environment()
raw = subprocess.check_output([str(go), "list", "-deps", "-json", "./cmd/bridge-net"], cwd=root / "native", env=env, text=True, encoding="utf-8")
decoder = json.JSONDecoder()
modules = {}
while raw.strip():
    value, end = decoder.raw_decode(raw.lstrip())
    module = value.get("Module")
    if module:
        modules[module["Path"]] = module
    raw = raw.lstrip()[end:]
notices = [f"Claude Bridge {version} — third-party notices\n\nThe native C++ desktop is statically linked with MinGW-w64 and uses nlohmann/json. This application embeds Tailscale tsnet (BSD-3-Clause), Node.js, Go, ws, and their dependencies. Tailscale's hosted coordination service is operated by Tailscale; this application is independently developed and is not endorsed by Tailscale.\n"]
licenses = [("Node.js runtime", node.parent / "LICENSE"), ("Go runtime", root / ".tools/go/LICENSE"), ("ws", root / "node_modules/ws/LICENSE"),
            ("MinGW-w64 runtime", root / ".tools/w64devkit/COPYING.MinGW-w64-runtime.txt"),
            ("nlohmann/json 3.12.0", root / "native/desktop/vendor/json-LICENSE.MIT")]
for module in modules.values():
    if not module.get("Dir") or module.get("Main"):
        continue
    directory = Path(module["Dir"])
    for file in module_license_files(directory):
        licenses.append((f"{module['Path']} {module.get('Version', '')} / {file.name}", file))
for label, file in licenses:
    if not file.is_file():
        raise FileNotFoundError(f"Missing license for {label}: {file}")
    notices.append(f"\n{'=' * 72}\n{label}\n{'=' * 72}\n{file.read_text(encoding='utf-8', errors='replace')}\n")
(root / "public/licenses.txt").write_text("".join(notices), encoding="utf-8")
payload = root / "native/cmd/bridge/runtime.zip"
payload.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(payload, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    def add(file, name):
        # Stable metadata keeps identical engine contents in the same cache directory.
        info = zipfile.ZipInfo(name, (2020, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100600 << 16
        archive.writestr(info, file.read_bytes(), compresslevel=6)
    for file in runtime_files():
        add(file, file.relative_to(root).as_posix())
    add(checked_path(node), "runtime/node.exe")
    add(checked_path(node.parent / "LICENSE"), "runtime/NODE-LICENSE.txt")
print(f"Runtime payload: {payload} ({payload.stat().st_size} bytes); {len(licenses)} license files included")
