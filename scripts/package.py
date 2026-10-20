"""Atomically package the audited source tree, checking available build provenance."""
import hashlib
import os
from pathlib import Path
import tempfile
import zipfile
if __package__:
    from .build_support import ROOT, VERSION, source_manifest, verify_build_record, verify_source_version
else:
    from build_support import ROOT, VERSION, source_manifest, verify_build_record, verify_source_version


def package_source(root=ROOT, version=VERSION):
    root = Path(root).resolve()
    verify_source_version(root, version)
    sources = source_manifest(root)
    verified = verify_build_record(root, version, sources)
    release = root / 'release'
    release.mkdir(exist_ok=True)
    target = release / f'claude-p2p-bridge-{version}.zip'
    with tempfile.NamedTemporaryFile(prefix=target.name + '.', suffix='.tmp', dir=release, delete=False) as stream:
        temporary = Path(stream.name)
    try:
        with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED) as archive:
            for name, expected in sources.items():
                data = (root / name).read_bytes()
                if hashlib.sha256(data).hexdigest() != expected:
                    raise ValueError(f'Source changed while packaging: {name}')
                info = zipfile.ZipInfo(f'claude-p2p-bridge-{version}/{name}', (2020, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                archive.writestr(info, data)
        if source_manifest(root) != sources:
            raise ValueError('Source changed while packaging; retry after edits finish')
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    return target, len(sources), verified


if __name__ == '__main__':
    target, count, verified = package_source()
    print(f'{target} ({count} files, {target.stat().st_size} bytes); '
          f'{"EXE/source build record verified" if verified else "source snapshot; no binary build record available"}')
