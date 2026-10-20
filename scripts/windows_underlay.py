"""Build a pinned, auditable Tailscale copy without changing the module cache.

Only the Windows default-interface selector is replaced. Go 1.27 does not allow
module-cache files in an overlay, so a temporary modfile selects this generated
copy. Both the upstream source and the project policy remain release inputs.
"""
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile
import time


TAILSCALE_VERSION = 'v1.104.1'
UPSTREAM_RELATIVE = Path('net/netmon/interfaces_windows.go')
UPSTREAM_SHA256 = '6d420c56aed7cbaf67e6aa381738d8180b26c65c18d27da00c4f501189d674ca'
POLICY_DIRECTORY = Path('native/_windows_underlay/netmon')
POLICY_FILES = ('underlay_windows.go', 'underlay_windows_test.go')


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def file_manifest(directory):
    return {path.relative_to(directory).as_posix(): sha256(path.read_bytes())
            for path in sorted(directory.rglob('*')) if path.is_file()}


def publish_directory(staging, destination):
    """Atomically rename a verified copy, bounding Windows sharing retries.

    Only retry the original rename; never delete a destination or bypass a
    failed publish. Permanent errors propagate after six attempts; delays
    total at most 0.75 seconds.
    """
    for attempt in range(6):
        try:
            staging.rename(destination)
            return
        except PermissionError as error:
            if sys.platform != 'win32' or getattr(error, 'winerror', None) not in {5, 32} or attempt == 5:
                raise
            time.sleep(0.05 * (attempt + 1))


def patch_selector(source):
    if sha256(source) != UPSTREAM_SHA256:
        raise ValueError('Tailscale Windows source checksum changed; review the underlay patch before building')
    text = source.decode('utf-8')
    start = text.index('// GetWindowsDefault returns ')
    end = text.index('\nfunc defaultRoute()', start)
    replacement = '''// GetWindowsDefault selects an active non-virtual default route.
// Claude Bridge must keep its transport outside other applications' TUNs.
// A missing underlay is an error, never permission to bind interface zero.
func GetWindowsDefault(family winipcfg.AddressFamily) (*winipcfg.IPAdapterAddresses, error) {
\tinterfaces, err := winipcfg.GetAdaptersAddresses(family, winipcfg.GAAFlagIncludeAllInterfaces)
\tif err != nil {
\t\treturn nil, err
\t}
\troutes, err := winipcfg.GetIPForwardTable2(family)
\tif err != nil {
\t\treturn nil, err
\t}
\treturn claudeBridgeDefaultUnderlay(family, interfaces, routes)
}
'''
    return (text[:start] + replacement + text[end:]).encode('utf-8')


def prepare_windows_underlay(root, env):
    """Return a child-process environment using the verified generated module."""
    root = Path(root).resolve()
    flags = env.get('GOFLAGS', '').strip()
    conflicting_flags = r'''(?:^|\s)["']?-(?:modfile|overlay)(?:=|\s|$)'''
    if re.search(r'''(?:^|\s)["']?-overlay(?:=|\s|$)''', flags):
        raise ValueError('Existing GOFLAGS -modfile/-overlay conflicts with the Windows underlay build')
    module_file = root / 'native/go.mod'
    sum_file = root / 'native/go.sum'
    module = module_file.read_bytes()
    sums = sum_file.read_bytes()
    module_text = module.decode('utf-8')
    versions = re.findall(r'(?m)^\s*(?:require\s+)?tailscale\.com\s+(v[^\s()]+)', module_text)
    if versions != [TAILSCALE_VERSION]:
        raise ValueError('Windows underlay policy requires the reviewed tailscale.com ' + TAILSCALE_VERSION)
    if re.search(r'(?m)^\s*replace\b', module_text):
        raise ValueError('Existing go.mod replace directives require review before the Windows underlay build')

    upstream = Path(env['GOMODCACHE']) / ('tailscale.com@' + TAILSCALE_VERSION)
    source = (upstream / UPSTREAM_RELATIVE).read_bytes()
    patched = patch_selector(source)
    policy = {name: (root / POLICY_DIRECTORY / name).read_bytes() for name in POLICY_FILES}
    upstream_manifest = file_manifest(upstream)
    inputs = {'tailscaleVersion': TAILSCALE_VERSION,
              'upstreamSourceSha256': UPSTREAM_SHA256,
              'upstreamManifestSha256': sha256(json.dumps(upstream_manifest, sort_keys=True).encode('utf-8')),
              'generatorSha256': sha256(Path(__file__).read_bytes()),
              'goModSha256': sha256(module), 'goSumSha256': sha256(sums),
              'policySha256': {name: sha256(data) for name, data in policy.items()}}
    key = sha256(json.dumps(inputs, sort_keys=True).encode('utf-8'))
    cache = root / '.cache/windows-underlay' / key
    shadow = cache / 'tailscale.com'
    own_flag = '"-modfile=' + (cache / 'build.mod').as_posix() + '"'
    if re.search(conflicting_flags, flags):
        # build_windows invokes prepare-windows with this environment. Permit
        # only the identical policy flag after recalculating its source key;
        # the entire generated module is still verified below before reuse.
        if flags == own_flag or flags.endswith(' ' + own_flag):
            flags = flags[:-len(own_flag)].rstrip()
        if re.search(conflicting_flags, flags):
            raise ValueError('Existing GOFLAGS -modfile/-overlay conflicts with the Windows underlay build')
    generated_mod = module.rstrip() + ('\n\nreplace tailscale.com => ' + json.dumps(shadow.as_posix(), ensure_ascii=False) + '\n').encode('utf-8')
    outputs = {'build.mod': generated_mod, 'build.sum': sums,
               'tailscale.com/' + UPSTREAM_RELATIVE.as_posix(): patched}
    for name, data in policy.items():
        outputs['tailscale.com/net/netmon/claude_bridge_' + name] = data
    shadow_manifest = upstream_manifest.copy()
    for name, data in outputs.items():
        if name.startswith('tailscale.com/'):
            shadow_manifest[name.removeprefix('tailscale.com/')] = sha256(data)
    receipt = {'v': 1, 'inputs': inputs,
               'shadowFiles': shadow_manifest,
               'outputs': {name: sha256(data) for name, data in outputs.items()}}

    if cache.exists():
        try:
            saved = json.loads((cache / 'receipt.json').read_text(encoding='utf-8'))
            if (saved != receipt or file_manifest(shadow) != shadow_manifest or
                    any(sha256((cache / name).read_bytes()) != digest
                        for name, digest in receipt['outputs'].items())):
                raise ValueError('receipt or generated content differs')
        except (OSError, ValueError) as error:
            raise ValueError('Windows underlay cache verification failed: ' + str(cache)) from error
    else:
        cache.parent.mkdir(parents=True, exist_ok=True)
        # TemporaryDirectory cleans up only its newly created staging directory.
        # Publish the receipt and module together, never a partially built copy.
        with tempfile.TemporaryDirectory(prefix='prepare-', dir=cache.parent) as temporary:
            staging = Path(temporary)
            shutil.copytree(upstream, staging / 'tailscale.com', copy_function=shutil.copyfile)
            for name, data in outputs.items():
                (staging / name).write_bytes(data)
            if file_manifest(staging / 'tailscale.com') != shadow_manifest:
                raise ValueError('Tailscale source changed while preparing the Windows underlay copy')
            (staging / 'receipt.json').write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n', encoding='utf-8')
            publish_directory(staging, cache)

    result = env.copy()
    result['GOFLAGS'] = (flags + ' ' + own_flag).strip()
    return result
