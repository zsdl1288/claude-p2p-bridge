"""Atomically package the audited source tree, checking available build provenance."""
import argparse
import hashlib
import os
from pathlib import Path
import tempfile
import zipfile
if __package__:
    from .build_support import ROOT, VERSION, checked_path, cleanup_release, source_manifest, verify_build_record, verify_source_version
else:
    from build_support import ROOT, VERSION, checked_path, cleanup_release, source_manifest, verify_build_record, verify_source_version


def package_source(root=ROOT, version=VERSION, *, cleanup=True):
    root = Path(root).resolve()
    verify_source_version(root, version)
    sources = source_manifest(root)
    verified = verify_build_record(root, version, sources)
    release = checked_path(root / 'release')
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
    if verified and cleanup:
        removed = cleanup_release(root, version, sources)
        if removed:
            print(f'Release cleanup: removed {len(removed)} old or duplicate files.')
    return target, len(sources), verified


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--keep-old', action='store_true', help='Keep old local artifacts until the new GitHub release is verified')
    options = parser.parse_args()
    target, count, verified = package_source(cleanup=not options.keep_old)
    print(f'{target} ({count} files, {target.stat().st_size} bytes); '
          f'{"EXE/source build record verified" if verified else "source snapshot; no binary build record available"}')
