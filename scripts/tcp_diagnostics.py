"""Audited, diagnostics-only additive Tailscale/gVisor shadow extensions."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import tempfile

try:
    from . import windows_underlay
except ImportError:
    import windows_underlay

TAILSCALE_VERSION = 'v1.104.1'
GVISOR_VERSION = 'v0.0.0-20260915211658-a6f909f08a72'
BUILD_MARKER = 'BRIDGE_TCP_DIAGNOSTICS_BUILD'
EXPECTED = {
    'tailscale.com': {'wgengine/netstack/netstack.go': '2eafcead8f32d3b58755aa6982eedeebb0fd152439e1dd498edc152cc5751d1f'},
    'gvisor.dev/gvisor': {
        'pkg/tcpip/transport/tcp/endpoint.go': '0b93c47f9c082161efde43d695a9b1d973e46ffc351b62f446ff1a7cbe062b91',
        'pkg/tcpip/transport/tcp/snd.go': '88620ed933425efa34baf809b6920567bf1e05d99159845427894f0eb98d33c9',
        'pkg/tcpip/tcpip.go': '2a55359717120852dccb0f227f4f0fbf78ebbf6d92164dc878f1924abc5a4291',
        'pkg/tcpip/stack/stack.go': 'c1ae20711f961ddb06a5cfc4e30d331c9789c2563f70b39247ee0eea2ef33166',
    },
}
TEMPLATES = {
    'tailscale': ('tailscale.com', 'wgengine/netstack'),
    'gvisor': ('gvisor', 'pkg/tcpip/transport/tcp'),
}
MODFILE_FLAG = re.compile(r'(?<!\S)"-modfile=([^"\r\n]+)"(?=\s|$)')


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def prepare_tcp_diagnostics(root, env):
    """Add source files in verified copies; never patch a protocol factory."""
    root = Path(root).resolve()
    flags = env.get('GOFLAGS', '').strip()
    inherited = None
    for match in MODFILE_FLAG.finditer(flags):
        candidate = Path(match.group(1)).resolve()
        if candidate.is_relative_to(root / '.cache/tcp-diagnostics') and candidate.name == 'build.mod':
            if inherited is not None:
                raise ValueError('Conflicting diagnostics GOFLAGS -modfile flags')
            inherited = match.group(0)
    if inherited:
        flags = flags.replace(inherited, '', 1).strip()
    # Reject unaudited inputs before either shadow generator creates a copy.
    # The underlay copy alone cannot validate the pinned gVisor dependency.
    module = (root / 'native/go.mod').read_bytes()
    sums = (root / 'native/go.sum').read_bytes()
    module_text = module.decode('utf-8')
    for name, version in [('tailscale.com', TAILSCALE_VERSION), ('gvisor.dev/gvisor', GVISOR_VERSION)]:
        versions = re.findall(r'(?m)^\s*(?:require\s+)?' + re.escape(name) + r'\s+(v[^\s()]+)', module_text)
        if versions != [version]:
            raise ValueError('TCP diagnostics requires reviewed module version: ' + name)
    if re.search(r'(?m)^\s*replace\b', module_text):
        raise ValueError('Existing go.mod replace directives require review before the TCP diagnostics build')
    upstream = {
        'tailscale.com': Path(env['GOMODCACHE']) / ('tailscale.com@' + TAILSCALE_VERSION),
        'gvisor.dev/gvisor': Path(env['GOMODCACHE']) / ('gvisor.dev/gvisor@' + GVISOR_VERSION),
    }
    for name, checks in EXPECTED.items():
        for relative, digest in checks.items():
            if sha256((upstream[name] / relative).read_bytes()) != digest:
                raise ValueError('TCP diagnostics upstream checksum changed: ' + name + '/' + relative)
    base_env = windows_underlay.prepare_windows_underlay(root, {**env, 'GOFLAGS': flags})
    base_match = MODFILE_FLAG.search(base_env['GOFLAGS'])
    if not base_match:
        raise ValueError('Verified Windows underlay modfile is missing')
    base = Path(base_match.group(1)).parent
    base_receipt = json.loads((base / 'receipt.json').read_text(encoding='utf-8'))
    sources = {'tailscale.com': base / 'tailscale.com', 'gvisor': upstream['gvisor.dev/gvisor']}
    manifests = {name: windows_underlay.file_manifest(directory) for name, directory in sources.items()}
    outputs = {}
    for category, (destination, package) in TEMPLATES.items():
        templates = root / 'native/_tcp_diagnostics' / category
        for filename in ('bridge_tcp_diagnostics.go', 'bridge_tcp_diagnostics_test.go'):
            relative = destination + '/' + package + '/' + filename
            if package + '/' + filename in manifests[destination]:
                raise ValueError('TCP diagnostic extension conflicts with upstream source')
            outputs[relative] = (templates / filename).read_bytes()
    inputs = {'v': 1, 'tailscaleVersion': TAILSCALE_VERSION, 'gvisorVersion': GVISOR_VERSION,
              'generatorSha256': sha256(Path(__file__).read_bytes()),
              'baseReceiptSha256': sha256(json.dumps(base_receipt, sort_keys=True).encode()),
              'upstreamManifests': {name: sha256(json.dumps(value, sort_keys=True).encode()) for name, value in manifests.items()},
              'goModSha256': sha256(module), 'goSumSha256': sha256(sums),
              'extensionSha256': {name: sha256(value) for name, value in outputs.items()}}
    key = sha256(json.dumps(inputs, sort_keys=True).encode())
    cache = root / '.cache/tcp-diagnostics' / key
    own_flag = '"-modfile=' + (cache / 'build.mod').as_posix() + '"'
    if inherited and inherited != own_flag:
        raise ValueError('Conflicting or stale diagnostics GOFLAGS -modfile')
    generated = module.rstrip() + ('\n\nreplace tailscale.com => ' + json.dumps((cache / 'tailscale.com').as_posix()) +
        '\nreplace gvisor.dev/gvisor => ' + json.dumps((cache / 'gvisor').as_posix()) + '\n').encode()
    outputs.update({'build.mod': generated, 'build.sum': sums})
    shadow_manifests = {name: manifest.copy() for name, manifest in manifests.items()}
    for name, value in outputs.items():
        destination, separator, relative = name.partition('/')
        if separator:
            shadow_manifests[destination][relative] = sha256(value)
    receipt = {'inputs': inputs, 'shadowFiles': shadow_manifests,
               'outputs': {name: sha256(value) for name, value in outputs.items()}}
    if cache.exists():
        try:
            saved = json.loads((cache / 'receipt.json').read_text(encoding='utf-8'))
            if saved != receipt or any(windows_underlay.file_manifest(cache / name) != manifest for name, manifest in shadow_manifests.items()) or any(sha256((cache / name).read_bytes()) != digest for name, digest in receipt['outputs'].items()):
                raise ValueError('Generated files or receipt differ')
        except (OSError, ValueError) as error:
            raise ValueError('TCP diagnostics cache verification failed') from error
    else:
        cache.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='prepare-', dir=cache.parent) as temporary:
            staging = Path(temporary)
            for name, directory in sources.items():
                shutil.copytree(directory, staging / name, copy_function=shutil.copyfile)
            for name, value in outputs.items():
                (staging / name).write_bytes(value)
            if any(windows_underlay.file_manifest(staging / name) != manifest for name, manifest in shadow_manifests.items()):
                raise ValueError('TCP diagnostics source changed during preparation')
            (staging / 'receipt.json').write_text(json.dumps(receipt, indent=2, sort_keys=True) + '\n', encoding='utf-8')
            windows_underlay.publish_directory(staging, cache)
    remaining_flags = base_env['GOFLAGS'].replace(base_match.group(0), '', 1).strip()
    return {**env, BUILD_MARKER: '1', 'GOFLAGS': (remaining_flags + ' ' + own_flag).strip()}
