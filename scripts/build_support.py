"""Shared release metadata, portable tool settings and source-package policy."""
import json
import hashlib
import os
from pathlib import Path
import re
import tempfile

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / '.tools'
VERSION = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
if not re.fullmatch(r'\d+\.\d+\.\d+', VERSION):
    raise ValueError('Release version must contain three numeric components')


def go_environment(*, offline=True, underlay_policy=True):
    env = os.environ.copy()
    env.update(GOPATH=str(ROOT / '.cache/go'), GOMODCACHE=str(ROOT / '.cache/gomod'),
               GOCACHE=str(ROOT / '.cache/gobuild'), CGO_ENABLED='0',
               GOPROXY='off' if offline else 'https://proxy.golang.org,direct')
    if underlay_policy and env.get('GOOS', 'windows' if os.name == 'nt' else '') == 'windows':
        try:
            from .windows_underlay import prepare_windows_underlay
        except ImportError:
            from windows_underlay import prepare_windows_underlay
        env = prepare_windows_underlay(ROOT, env)
    return env


def write_manifest(target):
    template = (ROOT / 'native/desktop/app.manifest').read_text(encoding='utf-8')
    marker = 'version="0.0.0.0"'
    if template.count(marker) != 1:
        raise ValueError('The desktop manifest must contain one assembly version placeholder')
    target.write_text(template.replace(marker, f'version="{VERSION}.0"'), encoding='utf-8')


PRIVATE_PARTS = {'.bridge', '.cache', '.tools', '__pycache__', 'api-token', 'pairing.dat', 'pairing-demo.dat', 'desktop.ini', 'tailscale.state', 'proxy.json', 'proxy-demo.json', 'application.json', 'application-demo.json'}


def checked_path(file):
    if file.is_symlink() or getattr(file, 'is_junction', lambda: False)() or file.resolve() != file.absolute():
        raise ValueError(f'Linked or external source path is not allowed: {file}')
    return file


def checked_file(file):
    checked_path(file)
    if not file.is_file():
        raise FileNotFoundError(f'Required release file is missing: {file}')
    return file


def packaged_files(root, directories, suffixes, *, forbidden=PRIVATE_PARTS):
    forbidden = {part.casefold() for part in forbidden}
    for name in directories:
        directory = checked_path(root / name)
        if not directory.is_dir():
            raise FileNotFoundError(f'Required release directory is missing: {directory}')
        for file in directory.rglob('*'):
            if forbidden.intersection(part.casefold() for part in file.relative_to(root).parts) or file.name.casefold().startswith('.env'):
                continue
            checked_path(file)
            if file.is_file() and file.suffix in suffixes:
                yield file


def source_files(root=ROOT):
    root = root.resolve()
    files = [checked_file(root / name) for name in ('package.json', 'package-lock.json', 'README.md', '.gitignore')]
    suffixes = {'.js', '.mjs', '.json', '.md', '.css', '.html', '.txt', '.py', '.go', '.mod', '.sum', '.hpp', '.cpp', '.manifest', '.MIT', '.jpg', '.png'}
    files.extend(packaged_files(root, ('src', 'public', 'scripts', 'test', 'examples', 'native'),
                                suffixes, forbidden=PRIVATE_PARTS | {'node_modules'}))
    return sorted(files)


def runtime_files(root=ROOT):
    """Only application modules/assets and the production ws package enter EXEs."""
    root = root.resolve()
    files = [checked_file(root / name) for name in ('package.json', 'package-lock.json', 'node_modules/ws/LICENSE')]
    files.extend(packaged_files(root, ('src', 'public', 'node_modules/ws'), {'.js', '.mjs', '.json', '.css', '.html', '.txt'}))
    return sorted(files)


def source_manifest(root=ROOT):
    """Portable content identities, shared by binary and source packaging."""
    root = root.resolve()
    return {file.relative_to(root).as_posix(): hashlib.sha256(file.read_bytes()).hexdigest()
            for file in source_files(root)}


def verify_source_version(root, version):
    package = json.loads((root / 'package.json').read_text(encoding='utf-8'))
    lock = json.loads((root / 'package-lock.json').read_text(encoding='utf-8'))
    if (package.get('version') != version or lock.get('version') != version
            or lock.get('packages', {}).get('', {}).get('version', version) != version):
        raise ValueError('Package, lockfile and release versions must match')


def atomic_write(file, data):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(prefix=file.name + '.', suffix='.tmp', dir=file.parent, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, file)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def verify_build_record(root, version, sources):
    """Old releases remain valid snapshots; new records prove the exact source."""
    executable = root / 'release' / f'ClaudeBridge-{version}-windows-x64.exe'
    record = executable.with_suffix('.build.json')
    if not record.is_file():
        return False
    value = json.loads(record.read_text(encoding='utf-8'))
    if (not isinstance(value, dict) or value.get('v') != 1 or value.get('version') != version or value.get('sources') != sources
            or value.get('executable') != executable.name or not executable.is_file()
            or value.get('sha256') != hashlib.sha256(executable.read_bytes()).hexdigest()):
        raise ValueError('Source or EXE differs from its build record; rebuild before packaging this release')
    return True
