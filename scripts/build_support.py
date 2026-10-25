"""Shared release metadata, portable tool settings and source-package policy."""
import json
import hashlib
import os
from pathlib import Path
import re
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / '.tools'
VERSION = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
if not re.fullmatch(r'\d+\.\d+\.\d+', VERSION):
    raise ValueError('Release version must contain three numeric components')


def go_environment(*, offline=True, underlay_policy=True, tcp_diagnostics=None, tcp_recovery=True):
    env = os.environ.copy()
    env.update(GOPATH=str(ROOT / '.cache/go'), GOMODCACHE=str(ROOT / '.cache/gomod'),
               GOCACHE=str(ROOT / '.cache/gobuild'), CGO_ENABLED='0',
               GOPROXY='off' if offline else 'https://proxy.golang.org,direct')
    # Only --diagnostics opts in. The marker propagates that explicit choice
    # to nested prepare-windows.py calls; normal builds explicitly opt out.
    diagnostics = env.get('BRIDGE_TCP_DIAGNOSTICS_BUILD') == '1' if tcp_diagnostics is None else tcp_diagnostics
    recovery = env.get('BRIDGE_TCP_RECOVERY_BUILD') == '1' if tcp_recovery is None else tcp_recovery
    if tcp_diagnostics is False:
        env.pop('BRIDGE_TCP_DIAGNOSTICS_BUILD', None)
    if tcp_recovery is False:
        env.pop('BRIDGE_TCP_RECOVERY_BUILD', None)
    elif recovery:
        env['BRIDGE_TCP_RECOVERY_BUILD'] = '1'
    if underlay_policy and env.get('GOOS', 'windows' if os.name == 'nt' else '') == 'windows':
        if recovery or 'tcp-recovery' in env.get('GOFLAGS', ''):
            try:
                from .tcp_recovery import prepare_tcp_recovery, strip_recovery_modfile
            except ImportError:
                from tcp_recovery import prepare_tcp_recovery, strip_recovery_modfile
            # A nested prepare-windows starts from the audited base, never
            # from an already patched sender copy or an inherited overlay.
            env = strip_recovery_modfile(ROOT, env)
        if diagnostics:
            try:
                from .tcp_diagnostics import prepare_tcp_diagnostics
            except ImportError:
                from tcp_diagnostics import prepare_tcp_diagnostics
            env = prepare_tcp_diagnostics(ROOT, env)
        else:
            try:
                from .windows_underlay import prepare_windows_underlay
            except ImportError:
                from windows_underlay import prepare_windows_underlay
            env = prepare_windows_underlay(ROOT, env)
        if recovery:
            env = prepare_tcp_recovery(ROOT, env)
    return env


def write_manifest(target):
    template = (ROOT / 'native/desktop/app.manifest').read_text(encoding='utf-8')
    marker = 'version="0.0.0.0"'
    if template.count(marker) != 1:
        raise ValueError('The desktop manifest must contain one assembly version placeholder')
    target.write_text(template.replace(marker, f'version="{VERSION}.0"'), encoding='utf-8')


def module_license_files(directory):
    """Keep license documents and named variants, excluding license test sources."""
    return [file for file in sorted(directory.iterdir())
            if file.is_file() and file.suffix.casefold() != '.go'
            and re.match(r'^(?:LICENSE|COPYING|NOTICE|AUTHORS|PATENTS)(?:$|[.-])',
                         file.name, re.IGNORECASE)]


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
    suffixes = {'.js', '.mjs', '.json', '.md', '.css', '.html', '.txt', '.py', '.go', '.mod', '.sum', '.hpp', '.cpp', '.rc', '.manifest', '.MIT', '.jpg', '.png'}
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


def cleanup_release(root, version, sources):
    """Prune known old artifacts only after a complete, verified release exists."""
    root = Path(root).resolve()
    release = checked_path(root / 'release')
    entries = [checked_path(file) for file in release.iterdir()]
    release_name = re.compile(
        r'^(?:ClaudeBridge-([0-9]+\.[0-9]+\.[0-9]+)-windows-x64\.(?:exe|sha256\.txt|build\.json)'
        r'|claude-p2p-bridge-([0-9]+\.[0-9]+\.[0-9]+)\.zip)$')
    current = tuple(map(int, version.split('.')))
    versioned = [(file, match.group(1) or match.group(2)) for file in entries
                 if file.is_file() and (match := release_name.fullmatch(file.name))]
    # Repacking a historical checkout must never remove a newer release,
    # including one whose build or source archive is not complete yet.
    if any(tuple(map(int, value.split('.'))) > current for _, value in versioned):
        return []
    verify_source_version(root, version)
    if not verify_build_record(root, version, sources):
        raise ValueError('A verified EXE build record is required before release cleanup')
    executable = checked_file(release / f'ClaudeBridge-{version}-windows-x64.exe')
    checksum = checked_file(executable.with_suffix('.sha256.txt'))
    record = checked_file(executable.with_suffix('.build.json'))
    if json.loads(record.read_text(encoding='utf-8')).get('diagnostics'):
        raise ValueError('A diagnostics build cannot replace the production release')
    checksum_parts = checksum.read_text(encoding='utf-8').split()
    if checksum_parts != [hashlib.sha256(executable.read_bytes()).hexdigest(), executable.name]:
        raise ValueError('EXE checksum file does not match; old releases were retained')
    archive = checked_file(release / f'claude-p2p-bridge-{version}.zip')
    with zipfile.ZipFile(archive) as package:
        expected = {f'claude-p2p-bridge-{version}/{name}': digest for name, digest in sources.items()}
        if len(package.infolist()) != len(expected) or set(package.namelist()) != set(expected):
            raise ValueError('Source archive entries differ from the build record')
        if any(hashlib.sha256(package.read(name)).hexdigest() != digest for name, digest in expected.items()):
            raise ValueError('Source archive content differs from the build record')
    candidates = [checked_file(file) for file, value in versioned
                  if tuple(map(int, value.split('.'))) < current]
    recovery_name = 'ClaudeBridge-Network-Recovery-windows-x64'
    recovery = release / f'{recovery_name}.zip'
    if recovery.exists():
        # Retain the portable recovery ZIP; remove loose copies only when the
        # ZIP contains exactly the same usable executable, checksum and guide.
        recovery_files = (f'{recovery_name}.exe', f'{recovery_name}.sha256.txt', 'NETWORK-RECOVERY-README.txt')
        with zipfile.ZipFile(checked_file(recovery)) as package:
            if len(package.infolist()) != 3 or set(package.namelist()) != set(recovery_files):
                raise ValueError('Offline recovery archive is incomplete; old releases were retained')
            contents = {name: package.read(name) for name in recovery_files}
        recovery_hash = hashlib.sha256(contents[recovery_files[0]]).hexdigest()
        if not contents[recovery_files[0]] or contents[recovery_files[1]].decode('utf-8-sig').split() != [recovery_hash, recovery_files[0]] or not contents[recovery_files[2]].strip():
            raise ValueError('Offline recovery checksum or guide is invalid; old releases were retained')
        for name, content in contents.items():
            file = release / name
            if file.exists() and checked_file(file).read_bytes() == content:
                candidates.append(file)
    # Preflight all candidates before the first deletion. Never recurse into
    # diagnostics or other directories, and leave unrecognized files alone.
    for file in candidates:
        checked_file(file)
    removed = []
    for file in candidates:
        checked_file(file).unlink()
        removed.append(file.name)
    return removed
