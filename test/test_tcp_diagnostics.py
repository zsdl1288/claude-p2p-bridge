from pathlib import Path
import os
import shutil
import unittest
from unittest.mock import patch

from scripts import build_support, tcp_diagnostics, windows_underlay
from test import test_windows_underlay as fixtures


class TCPDiagnosticsBuildTests(unittest.TestCase):
    def setUp(self):
        fixtures.WindowsUnderlayBuildTests.setUp(self)
        module = self.root / 'native/go.mod'
        module.write_text(module.read_text() + '\nrequire gvisor.dev/gvisor ' + tcp_diagnostics.GVISOR_VERSION + '\n')
        gvisor = Path(self.env['GOMODCACHE']) / ('gvisor.dev/gvisor@' + tcp_diagnostics.GVISOR_VERSION)
        (gvisor / 'go.mod').parent.mkdir(parents=True)
        (gvisor / 'go.mod').write_text('module gvisor.dev/gvisor\n')
        expected = {}
        for name, files in tcp_diagnostics.EXPECTED.items():
            directory = self.upstream if name == 'tailscale.com' else gvisor
            expected[name] = {}
            for relative in files:
                target = directory / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('// reviewed fixture ' + relative + '\npackage fixture\n')
                expected[name][relative] = tcp_diagnostics.sha256(target.read_bytes())
        checksum = patch.object(tcp_diagnostics, 'EXPECTED', expected)
        checksum.start()
        self.addCleanup(checksum.stop)
        for category in tcp_diagnostics.TEMPLATES:
            shutil.copytree(build_support.ROOT / 'native/_tcp_diagnostics' / category,
                            self.root / 'native/_tcp_diagnostics' / category)
        self.gvisor = gvisor

    def prepare(self, env=None):
        return tcp_diagnostics.prepare_tcp_diagnostics(self.root, self.env if env is None else env)

    def cache(self):
        return next((self.root / '.cache/tcp-diagnostics').glob('*/receipt.json')).parent

    def test_additive_copies_preserve_upstream_and_are_safely_reentrant(self):
        original = {name: windows_underlay.file_manifest(directory) for name, directory in
                    [('tailscale', self.upstream), ('gvisor', self.gvisor)]}
        result = self.prepare()
        cache = self.cache()
        self.assertEqual(self.prepare(result), result)
        self.assertEqual(result[tcp_diagnostics.BUILD_MARKER], '1')
        generated = (cache / 'build.mod').read_text()
        self.assertIn('replace tailscale.com => ', generated)
        self.assertIn('replace gvisor.dev/gvisor => ', generated)
        self.assertEqual(windows_underlay.file_manifest(self.upstream), original['tailscale'])
        self.assertEqual(windows_underlay.file_manifest(self.gvisor), original['gvisor'])
        shadow = windows_underlay.file_manifest(cache / 'gvisor')
        for relative, digest in original['gvisor'].items():
            self.assertEqual(shadow[relative], digest, 'diagnostics must not alter any upstream algorithm')
        self.assertEqual(len(shadow), len(original['gvisor']) + 2)

    def test_nested_build_environment_and_explicit_normal_opt_out(self):
        with patch.object(build_support, 'ROOT', self.root), patch.dict(os.environ, {**self.env, 'GOOS': 'windows'}, clear=True):
            diagnostic = build_support.go_environment(tcp_diagnostics=True, tcp_recovery=False)
        with patch.object(build_support, 'ROOT', self.root), patch.dict(os.environ, {**diagnostic, 'GOOS': 'windows'}, clear=True):
            self.assertEqual(build_support.go_environment(tcp_recovery=False)['GOFLAGS'], diagnostic['GOFLAGS'])
            with self.assertRaisesRegex(ValueError, 'conflicts'):
                build_support.go_environment(tcp_diagnostics=False, tcp_recovery=False)
        with patch.object(build_support, 'ROOT', self.root), patch.dict(os.environ, {**self.env, 'GOOS': 'windows', tcp_diagnostics.BUILD_MARKER: '1'}, clear=True):
            normal = build_support.go_environment(tcp_diagnostics=False, tcp_recovery=False)
        self.assertNotIn(tcp_diagnostics.BUILD_MARKER, normal)
        self.assertNotIn('tcp-diagnostics', normal['GOFLAGS'])
        normal_mod = Path(tcp_diagnostics.MODFILE_FLAG.search(normal['GOFLAGS']).group(1))
        self.assertNotIn('gvisor.dev/gvisor =>', normal_mod.read_text())

    def test_unreviewed_input_versions_hashes_and_go_flags_are_rejected(self):
        def assert_rejected_before_copy(message):
            with patch.object(windows_underlay, 'prepare_windows_underlay') as prepare_underlay:
                with self.assertRaisesRegex(ValueError, message):
                    self.prepare()
            prepare_underlay.assert_not_called()
            self.assertFalse((self.root / '.cache/windows-underlay').exists())
            self.assertFalse((self.root / '.cache/tcp-diagnostics').exists())

        for path in [self.gvisor / 'pkg/tcpip/transport/tcp/snd.go',
                     self.upstream / 'wgengine/netstack/netstack.go']:
            with self.subTest(path=path):
                original = path.read_bytes()
                path.write_bytes(original + b'// modified algorithm\n')
                assert_rejected_before_copy('checksum changed')
                path.write_bytes(original)
        module = self.root / 'native/go.mod'
        original = module.read_text()
        for version in [tcp_diagnostics.GVISOR_VERSION, tcp_diagnostics.TAILSCALE_VERSION]:
            with self.subTest(version=version):
                module.write_text(original.replace(version, 'v0.0.0-unreviewed'))
                assert_rejected_before_copy('reviewed module version')
        module.write_text(original + '\nreplace gvisor.dev/gvisor => ../unreviewed\n')
        assert_rejected_before_copy('replace directives require review')
        module.write_text(original)
        for flags in ['-overlay=other.json', '-modfile=other.mod', '"-modfile=foreign with spaces.mod"',
                      '"-modfile=' + (self.root / '.cache/tcp-diagnostics/foreign/build.mod').as_posix() + '"']:
            with self.subTest(flags=flags), self.assertRaisesRegex(ValueError, 'conflict|Conflicting'):
                self.prepare({**self.env, 'GOFLAGS': flags})

    def test_cache_manifest_extension_and_receipt_drift_are_rejected(self):
        self.prepare()
        cache = self.cache()
        for relative in ['build.mod', 'receipt.json', 'gvisor/pkg/tcpip/transport/tcp/bridge_tcp_diagnostics.go',
                         'gvisor/pkg/tcpip/transport/tcp/snd.go', 'tailscale.com/wgengine/netstack/bridge_tcp_diagnostics.go']:
            with self.subTest(relative=relative):
                target = cache / relative
                original = target.read_bytes()
                target.write_bytes(original + b'\nchanged')
                with self.assertRaisesRegex(ValueError, 'cache verification failed'):
                    self.prepare()
                target.write_bytes(original)
        extra = cache / 'gvisor/extra.go'
        extra.write_text('package extra\n')
        with self.assertRaisesRegex(ValueError, 'cache verification failed'):
            self.prepare()

    def test_source_package_includes_all_extension_build_inputs(self):
        names = {path.relative_to(build_support.ROOT).as_posix() for path in build_support.source_files()}
        self.assertIn('scripts/tcp_diagnostics.py', names)
        for category in tcp_diagnostics.TEMPLATES:
            for name in ('bridge_tcp_diagnostics.go', 'bridge_tcp_diagnostics_test.go'):
                self.assertIn('native/_tcp_diagnostics/' + category + '/' + name, names)


if __name__ == '__main__':
    unittest.main()
