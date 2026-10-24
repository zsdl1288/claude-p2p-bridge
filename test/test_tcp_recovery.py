from pathlib import Path
import copy
import json
import os
import unittest
from unittest.mock import patch

from scripts import build_support, tcp_diagnostics, tcp_recovery, windows_underlay
from test import test_tcp_diagnostics as fixtures


class TCPRecoveryBuildTests(unittest.TestCase):
    def setUp(self):
        fixtures.TCPDiagnosticsBuildTests.setUp(self)
        self.sender_name = 'pkg/tcpip/transport/tcp/snd.go'
        self.sender = self.gvisor / self.sender_name
        self.original_sender = self.sender.read_bytes()
        self.policy = {
            'v': 1, 'moduleVersion': tcp_diagnostics.GVISOR_VERSION,
            'files': [{'path': self.sender_name, 'sha256': tcp_recovery.sha256(self.original_sender),
                       'replacements': [{'old': '// reviewed fixture ', 'new': '// reviewed sender fix '}]}],
        }
        self.policy_path = self.root / tcp_recovery.POLICY_PATH
        self.policy_path.parent.mkdir(parents=True)
        self.write_policy()
        self.test_path = self.root / tcp_recovery.TEST_DIRECTORY / 'bridge_tcp_recovery_test.go'
        self.test_path.parent.mkdir()
        self.test_path.write_bytes(b'package tcp\n// reviewed sender regression test fixture\n')

    def write_policy(self, policy=None):
        self.policy_path.write_text(json.dumps(self.policy if policy is None else policy, indent=2) + '\n', encoding='utf-8')

    def prepare(self, env=None):
        return tcp_recovery.prepare_tcp_recovery(self.root, self.env if env is None else env)

    def cache(self, env):
        return Path(tcp_recovery.MODFILE_FLAG.search(env['GOFLAGS']).group(1)).parent

    def go_environment(self, env=None, **kwargs):
        with patch.object(build_support, 'ROOT', self.root), patch.dict(
                os.environ, {**(self.env if env is None else env), 'GOOS': 'windows'}, clear=True):
            return build_support.go_environment(**kwargs)

    def test_audited_copy_is_identical_on_reuse_and_never_mutates_inputs(self):
        original = windows_underlay.file_manifest(self.gvisor)
        root_mod = (self.root / 'native/go.mod').read_bytes()
        root_sum = (self.root / 'native/go.sum').read_bytes()
        result = self.prepare()
        cache = self.cache(result)
        self.assertEqual(self.prepare(), result)
        self.assertEqual(self.prepare(result), result)
        self.assertEqual(result[tcp_recovery.BUILD_MARKER], '1')
        self.assertEqual(windows_underlay.file_manifest(self.gvisor), original)
        self.assertEqual((self.root / 'native/go.mod').read_bytes(), root_mod)
        self.assertEqual((self.root / 'native/go.sum').read_bytes(), root_sum)
        self.assertEqual((cache / 'build.sum').read_bytes(), root_sum)
        self.assertEqual((cache / 'gvisor' / self.sender_name).read_bytes(),
                         self.original_sender.replace(b'// reviewed fixture ', b'// reviewed sender fix '))
        self.assertEqual((cache / 'gvisor' / tcp_recovery.TCP_DIRECTORY / self.test_path.name).read_bytes(), self.test_path.read_bytes())
        generated = (cache / 'build.mod').read_text()
        self.assertEqual(generated.count('replace gvisor.dev/gvisor =>'), 1)
        self.assertIn('replace tailscale.com => ', generated)
        self.assertIn('windows-underlay', generated)
        self.assertIn(json.dumps((cache / 'gvisor').as_posix()), generated)

    def test_diagnostics_then_recovery_preserves_extensions_and_tailscale_provider(self):
        result = self.go_environment(tcp_diagnostics=True, tcp_recovery=True)
        cache = self.cache(result)
        self.assertEqual(self.go_environment(result), result)
        self.assertIn('tcp-diagnostics', (cache / 'build.mod').read_text())
        for name in ('bridge_tcp_diagnostics.go', 'bridge_tcp_diagnostics_test.go', self.test_path.name):
            self.assertTrue((cache / 'gvisor' / tcp_recovery.TCP_DIRECTORY / name).is_file())
        self.assertIn(b'// reviewed sender fix ', (cache / 'gvisor' / self.sender_name).read_bytes())
        # The stock provider used to prepare diagnostics is still pristine.
        self.assertEqual(self.sender.read_bytes(), self.original_sender)
        base = next((self.root / '.cache/tcp-diagnostics').glob('*/gvisor'))
        self.assertEqual((base / self.sender_name).read_bytes(), self.original_sender)

    def test_default_recovery_nested_marker_only_and_explicit_opt_out(self):
        with patch.object(tcp_recovery, 'prepare_tcp_recovery', wraps=tcp_recovery.prepare_tcp_recovery) as prepare:
            baseline = self.go_environment(tcp_recovery=False)
            prepare.assert_not_called()
        self.assertNotIn(tcp_recovery.BUILD_MARKER, baseline)
        self.assertNotIn('tcp-recovery', baseline['GOFLAGS'])
        enabled = self.go_environment(tcp_recovery=True)
        self.assertEqual(self.go_environment(), enabled, 'normal Windows builds must include the recovery policy')
        self.assertEqual(self.go_environment(enabled), enabled)
        opted_out = self.go_environment(enabled, tcp_recovery=False)
        self.assertNotIn(tcp_recovery.BUILD_MARKER, opted_out)
        self.assertNotIn('tcp-recovery', opted_out['GOFLAGS'])
        self.assertEqual(opted_out['GOFLAGS'], baseline['GOFLAGS'])
        implicit = self.go_environment({**self.env, tcp_recovery.BUILD_MARKER: '1'}, tcp_recovery=None)
        self.assertEqual(implicit['GOFLAGS'], enabled['GOFLAGS'])
        marker_only_baseline = self.go_environment(tcp_recovery=None)
        self.assertEqual(marker_only_baseline['GOFLAGS'], baseline['GOFLAGS'])
        diagnostic = self.go_environment(tcp_diagnostics=True, tcp_recovery=True)
        without_recovery = self.go_environment(diagnostic, tcp_recovery=False)
        self.assertEqual(without_recovery[tcp_diagnostics.BUILD_MARKER], '1')
        self.assertNotIn('tcp-recovery', without_recovery['GOFLAGS'])
        self.assertIn('tcp-diagnostics', without_recovery['GOFLAGS'])
        bootstrap = self.go_environment(tcp_recovery=True, underlay_policy=False, offline=False)
        self.assertEqual(bootstrap['GOFLAGS'], self.env['GOFLAGS'])

    def test_only_own_recovery_flag_is_discarded_before_rebuilding_base(self):
        enabled = self.go_environment(tcp_recovery=True)
        own_flag = tcp_recovery.MODFILE_FLAG.search(enabled['GOFLAGS']).group(0)
        stale = '"-modfile=' + (self.root / '.cache/tcp-recovery' / ('0' * 64) / 'build.mod').as_posix() + '"'
        self.assertEqual(self.go_environment({**enabled, 'GOFLAGS': '-p=4 ' + stale}), enabled)
        foreign = [
            '-modfile=other.mod', '-modfile other.mod', '"-modfile=foreign with spaces.mod"',
            '-overlay=other.json', "'-overlay=other with spaces.json'", '-overlay other.json',
            '"-modfile=' + (self.root / '.cache/tcp-recovery/foreign/build.mod').as_posix() + '"',
            '"-modfile=' + (self.root / '.cache/tcp-recovery-lookalike' / ('0' * 64) / 'build.mod').as_posix() + '"',
            own_flag + ' ' + own_flag, own_flag + ' -modfile=other.mod',
        ]
        for flags in foreign:
            with self.subTest(flags=flags), self.assertRaisesRegex(ValueError, 'conflict|Conflicting'):
                self.go_environment({**enabled, 'GOFLAGS': flags})

    def test_policy_checks_version_original_hash_and_exactly_once_replacements(self):
        original = copy.deepcopy(self.policy)
        invalid = []
        wrong_version = copy.deepcopy(original)
        wrong_version['moduleVersion'] = 'v0.0.0-unreviewed'
        invalid.append((wrong_version, 'reviewed gvisor module version'))
        wrong_hash = copy.deepcopy(original)
        wrong_hash['files'][0]['sha256'] = '0' * 64
        invalid.append((wrong_hash, 'checksum changed'))
        missing = copy.deepcopy(original)
        missing['files'][0]['replacements'][0]['old'] = 'no such original text'
        invalid.append((missing, 'exactly once'))
        for policy, message in invalid:
            with self.subTest(message=message):
                self.write_policy(policy)
                with self.assertRaisesRegex(ValueError, message):
                    self.prepare()
        duplicate_text = self.original_sender + b'// reviewed fixture twice\n'
        self.sender.write_bytes(duplicate_text)
        double = copy.deepcopy(original)
        double['files'][0]['sha256'] = tcp_recovery.sha256(duplicate_text)
        # Update the diagnostics fixture hash only; recovery must still reject
        # the ambiguous policy instead of silently choosing one occurrence.
        self.write_policy(double)
        with self.assertRaisesRegex(ValueError, 'exactly once'):
            self.prepare()
        self.assertFalse((self.root / '.cache/tcp-recovery').exists())

    def test_policy_schema_paths_and_noop_or_empty_patches_fail_closed(self):
        invalid = [[], {'v': 1}, {**self.policy, 'v': True}, {**self.policy, 'files': []}]
        for path in ('../snd.go', 'pkg/tcpip/transport/tcp/../snd.go',
                     'pkg/tcpip/transport/tcp/snd.go:extra', 'pkg/tcpip/transport/tcp//snd.go'):
            policy = copy.deepcopy(self.policy)
            policy['files'][0]['path'] = path
            invalid.append(policy)
        duplicate = copy.deepcopy(self.policy)
        duplicate['files'].append(copy.deepcopy(duplicate['files'][0]))
        invalid.append(duplicate)
        for change in ({'old': '', 'new': 'x'}, {'old': 'x', 'new': 'x'}, {'old': 'x', 'new': 3}):
            policy = copy.deepcopy(self.policy)
            policy['files'][0]['replacements'] = [change]
            invalid.append(policy)
        for policy in invalid:
            with self.subTest(policy=policy), self.assertRaisesRegex(ValueError, 'policy'):
                self.write_policy(policy)
                self.prepare()
        self.assertFalse((self.root / '.cache/tcp-recovery').exists())

    def test_policy_replacements_are_applied_in_reviewed_order(self):
        self.policy['files'][0]['replacements'].append({'old': '// reviewed sender fix ', 'new': '// reviewed final fix '})
        self.write_policy()
        result = self.prepare()
        self.assertIn(b'// reviewed final fix ', (self.cache(result) / 'gvisor' / self.sender_name).read_bytes())

    def test_upstream_and_test_name_collisions_fail_closed(self):
        self.test_path.rename(self.test_path.with_name('snd.go'))
        with self.assertRaisesRegex(ValueError, 'conflicts with upstream'):
            self.prepare()

    def test_source_drift_rejects_reuse_and_changed_build_inputs_get_new_keys(self):
        first = self.prepare()
        original = self.sender.read_bytes()
        self.sender.write_bytes(original + b'// upstream drift\n')
        with self.assertRaisesRegex(ValueError, 'checksum changed'):
            self.prepare(first)
        self.sender.write_bytes(original)
        previous = self.cache(first)
        for target, addition in [(self.test_path, b'// new regression\n'),
                                 (self.policy_path, b'\n'),
                                 (self.root / 'native/go.mod', b'\n// metadata changed\n'),
                                 (self.root / 'native/go.sum', b'// sums changed\n'),
                                 (self.gvisor / 'go.mod', b'// source manifest changed\n')]:
            with self.subTest(target=target):
                target.write_bytes(target.read_bytes() + addition)
                result = self.prepare(first)
                current = self.cache(result)
                self.assertNotEqual(current, previous)
                self.assertEqual(self.prepare(result), result)
                previous = current

    def test_complete_generated_cache_rejects_drift_additions_and_missing_files(self):
        result = self.prepare()
        cache = self.cache(result)
        for relative in ('build.mod', 'build.sum', 'receipt.json', 'gvisor/go.mod',
                         'gvisor/' + self.sender_name,
                         'gvisor/' + tcp_recovery.TCP_DIRECTORY + self.test_path.name):
            with self.subTest(relative=relative):
                target = cache / relative
                original = target.read_bytes()
                target.write_bytes(original + b'\nchanged')
                with self.assertRaisesRegex(ValueError, 'cache verification failed'):
                    self.prepare(result)
                target.write_bytes(original)
        for relative in ('unexpected.txt', 'gvisor/pkg/tcpip/transport/tcp/extra.go'):
            extra = cache / relative
            extra.write_text('unexpected source\n')
            with self.assertRaisesRegex(ValueError, 'cache verification failed'):
                self.prepare(result)
            extra.unlink()
        missing = cache / 'gvisor/go.mod'
        missing.unlink()
        with self.assertRaisesRegex(ValueError, 'cache verification failed'):
            self.prepare(result)

    def test_tampered_base_provider_cannot_be_treated_as_a_trusted_modfile(self):
        result = self.go_environment(tcp_diagnostics=True, tcp_recovery=True)
        base = next((self.root / '.cache/tcp-diagnostics').glob('*/build.mod'))
        base.write_text(base.read_text() + 'replace evil.example/source => ../outside\n')
        with self.assertRaisesRegex(ValueError, 'cache verification failed'):
            self.prepare(result)


if __name__ == '__main__':
    unittest.main()
