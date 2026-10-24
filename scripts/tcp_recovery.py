"""Build an audited gVisor sender copy without modifying the module cache.

The reviewed policy is applied after the normal Windows underlay/optional
diagnostics provider. Go 1.27 requires a source copy rather than an overlay of
module-cache files. Every input and generated file is covered by the receipt.
"""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import tempfile

try:
    from . import tcp_diagnostics, windows_underlay
except ImportError:
    import tcp_diagnostics
    import windows_underlay


BUILD_MARKER = 'BRIDGE_TCP_RECOVERY_BUILD'
POLICY_PATH = Path('native/_tcp_recovery/policy.json')
TEST_DIRECTORY = Path('native/_tcp_recovery/gvisor')
TCP_DIRECTORY = 'pkg/tcpip/transport/tcp/'
MODFILE_FLAG = re.compile(r'(?<!\S)"-modfile=([^"\r\n]+)"(?=\s|$)')
CONFLICTING_FLAG = re.compile(r'''(?:^|\s)["']?-(?:modfile|overlay)(?:=|\s|$)''')
SHA256 = re.compile(r'[0-9a-f]{64}')


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def _cache_modfile(root, path, category):
    candidate = Path(path).resolve()
    parent = (root / '.cache' / category).resolve()
    try:
        relative = candidate.relative_to(parent)
    except ValueError:
        return None
    if len(relative.parts) != 2 or not SHA256.fullmatch(relative.parts[0]) or relative.parts[1] != 'build.mod':
        return None
    return candidate


def strip_recovery_modfile(root, env):
    """Remove only this generator's flag before rebuilding its base provider.

    A stale own key is safe to discard: it is never used as an input. The new
    key is recomputed from reviewed inputs and its complete cache is verified.
    Unknown modfiles and overlays remain errors, never alternate build inputs.
    """
    root = Path(root).resolve()
    flags = env.get('GOFLAGS', '').strip()
    own = [match for match in MODFILE_FLAG.finditer(flags)
           if _cache_modfile(root, match.group(1), 'tcp-recovery') is not None]
    if len(own) > 1:
        raise ValueError('Conflicting TCP recovery GOFLAGS -modfile flags')
    if own:
        flags = flags.replace(own[0].group(0), '', 1).strip()
    return {**env, 'GOFLAGS': flags}


def _manifest(directory):
    # Copy only ordinary source files. A link/reparse entry must not redirect
    # the receipt to source outside the selected, verified module directory.
    directory = Path(directory)
    paths = [directory, *sorted(directory.rglob('*'))]
    result = {}
    for path in paths:
        info = path.lstat()
        if path.is_symlink() or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('TCP recovery source/cache contains a linked entry')
        if path.is_file():
            result[path.relative_to(directory).as_posix()] = sha256(path.read_bytes())
    return result


def _read_policy(root):
    raw = (root / POLICY_PATH).read_bytes()
    policy = json.loads(raw.decode('utf-8'))
    if (not isinstance(policy, dict) or set(policy) != {'v', 'moduleVersion', 'files'} or
            type(policy['v']) is not int or policy['v'] != 1 or
            not isinstance(policy['moduleVersion'], str) or
            not re.fullmatch(r'v[0-9][A-Za-z0-9.+-]*', policy['moduleVersion']) or
            not isinstance(policy['files'], list)):
        raise ValueError('TCP recovery policy schema invalid')
    if not policy['files']:
        raise ValueError('TCP recovery policy has no reviewed patches')
    seen = set()
    for item in policy['files']:
        if not isinstance(item, dict) or set(item) != {'path', 'sha256', 'replacements'}:
            raise ValueError('TCP recovery policy file schema invalid')
        name = item['path']
        if (not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9_./-]+', name) or not name.startswith(TCP_DIRECTORY) or
                not name.endswith('.go') or '\\' in name or
                PurePosixPath(name).as_posix() != name or
                any(part in {'.', '..'} for part in PurePosixPath(name).parts) or name in seen):
            raise ValueError('TCP recovery policy path invalid or duplicate')
        seen.add(name)
        if not isinstance(item['sha256'], str) or not SHA256.fullmatch(item['sha256']):
            raise ValueError('TCP recovery policy source checksum invalid')
        if not isinstance(item['replacements'], list) or not item['replacements']:
            raise ValueError('TCP recovery policy replacements missing')
        for change in item['replacements']:
            if (not isinstance(change, dict) or set(change) != {'old', 'new'} or
                    not isinstance(change['old'], str) or not change['old'] or
                    not isinstance(change['new'], str) or change['old'] == change['new']):
                raise ValueError('TCP recovery policy replacement invalid')
    return raw, policy


def _prepare_base(root, env):
    clean = strip_recovery_modfile(root, env)
    # Re-run the provider, including its full receipt checks. Merely trusting a
    # modfile under a familiar directory would accept forged cached replaces.
    if clean.get(tcp_diagnostics.BUILD_MARKER) == '1':
        base_env = tcp_diagnostics.prepare_tcp_diagnostics(root, clean)
        category = 'tcp-diagnostics'
    else:
        base_env = windows_underlay.prepare_windows_underlay(root, clean)
        category = 'windows-underlay'
    matches = list(MODFILE_FLAG.finditer(base_env.get('GOFLAGS', '')))
    if len(matches) != 1:
        raise ValueError('TCP recovery verified base modfile missing or conflicting')
    match = matches[0]
    modfile = _cache_modfile(root, match.group(1), category)
    if modfile is None:
        raise ValueError('TCP recovery base modfile is not a reviewed provider')
    remaining = base_env['GOFLAGS'].replace(match.group(0), '', 1).strip()
    if CONFLICTING_FLAG.search(remaining):
        raise ValueError('Conflicting TCP recovery GOFLAGS -modfile/-overlay')
    return base_env, modfile, remaining, category


def prepare_tcp_recovery(root, env):
    """Return an environment selecting only the reviewed sender source copy."""
    root = Path(root).resolve()
    raw_policy, policy = _read_policy(root)
    module = (root / 'native/go.mod').read_bytes()
    sums = (root / 'native/go.sum').read_bytes()
    versions = re.findall(r'(?m)^\s*(?:require\s+)?gvisor\.dev/gvisor\s+(v[^\s()]+)', module.decode('utf-8'))
    if versions != [policy['moduleVersion']]:
        raise ValueError('TCP recovery requires reviewed gvisor module version')
    base_env, base_modfile, flags, category = _prepare_base(root, env)
    base_module = base_modfile.read_bytes()
    base_receipt = (base_modfile.parent / 'receipt.json').read_bytes()
    source = (base_modfile.parent / 'gvisor' if category == 'tcp-diagnostics' else
              Path(env['GOMODCACHE']) / ('gvisor.dev/gvisor@' + policy['moduleVersion']))
    source_manifest = _manifest(source)
    outputs = {}
    for item in policy['files']:
        name = item['path']
        data = (source / name).read_bytes()
        if sha256(data) != item['sha256']:
            raise ValueError('TCP recovery upstream checksum changed: ' + name)
        text = data.decode('utf-8')
        for change in item['replacements']:
            if text.count(change['old']) != 1:
                raise ValueError('TCP recovery replacement must occur exactly once: ' + name)
            text = text.replace(change['old'], change['new'], 1)
        outputs['gvisor/' + name] = text.encode('utf-8')
    tests = {}
    for path in sorted((root / TEST_DIRECTORY).glob('*.go')):
        if path.is_symlink() or getattr(path.lstat(), 'st_file_attributes', 0) & 0x400:
            raise ValueError('TCP recovery test contains a linked entry')
        relative = TCP_DIRECTORY + path.name
        if relative in source_manifest:
            raise ValueError('TCP recovery test conflicts with upstream source: ' + path.name)
        tests[relative] = path.read_bytes()
        outputs['gvisor/' + relative] = tests[relative]
    inputs = {
        'v': 1, 'moduleVersion': policy['moduleVersion'],
        'generatorSha256': sha256(Path(__file__).read_bytes()), 'policySha256': sha256(raw_policy),
        'goModSha256': sha256(module), 'goSumSha256': sha256(sums),
        'baseModfileSha256': sha256(base_module), 'baseReceiptSha256': sha256(base_receipt),
        'sourceManifestSha256': sha256(json.dumps(source_manifest, sort_keys=True).encode()),
        'testSha256': {name: sha256(data) for name, data in tests.items()},
    }
    key = sha256(json.dumps(inputs, sort_keys=True).encode())
    cache = root / '.cache/tcp-recovery' / key
    own_flag = '"-modfile=' + (cache / 'build.mod').as_posix() + '"'
    # Preserve the verified Tailscale provider and replace only its gVisor
    # selection. The stock underlay base has no gVisor replace to remove.
    generated = base_module.decode('utf-8')
    old_replace = 'replace gvisor.dev/gvisor => ' + json.dumps((base_modfile.parent / 'gvisor').as_posix()) + '\n'
    if category == 'tcp-diagnostics':
        if generated.count(old_replace) != 1:
            raise ValueError('TCP recovery base gvisor replacement invalid')
        generated = generated.replace(old_replace, '', 1)
    if re.search(r'(?m)^\s*replace\s+gvisor\.dev/gvisor\b', generated):
        raise ValueError('TCP recovery base gvisor replacement conflicts')
    generated = generated.rstrip() + '\nreplace gvisor.dev/gvisor => ' + json.dumps((cache / 'gvisor').as_posix()) + '\n'
    outputs.update({'build.mod': generated.encode('utf-8'), 'build.sum': sums})
    shadow_manifest = source_manifest.copy()
    for name, data in outputs.items():
        if name.startswith('gvisor/'):
            shadow_manifest[name.removeprefix('gvisor/')] = sha256(data)
    receipt = {'v': 1, 'inputs': inputs, 'shadowFiles': shadow_manifest,
               'outputs': {name: sha256(data) for name, data in outputs.items()}}
    receipt_bytes = (json.dumps(receipt, indent=2, sort_keys=True) + '\n').encode('utf-8')
    expected_cache = {'gvisor/' + name: digest for name, digest in shadow_manifest.items()}
    expected_cache.update({name: sha256(data) for name, data in outputs.items()})
    expected_cache['receipt.json'] = sha256(receipt_bytes)
    if cache.exists():
        try:
            if _manifest(cache) != expected_cache:
                raise ValueError('Generated files or receipt differ')
        except (OSError, ValueError) as error:
            raise ValueError('TCP recovery cache verification failed') from error
    else:
        cache.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='prepare-', dir=cache.parent) as temporary:
            staging = Path(temporary)
            shutil.copytree(source, staging / 'gvisor', copy_function=shutil.copyfile)
            for name, data in outputs.items():
                (staging / name).write_bytes(data)
            (staging / 'receipt.json').write_bytes(receipt_bytes)
            if _manifest(staging) != expected_cache:
                raise ValueError('gVisor source changed during TCP recovery preparation')
            windows_underlay.publish_directory(staging, cache)
    return {**base_env, BUILD_MARKER: '1', 'GOFLAGS': (flags + ' ' + own_flag).strip()}
