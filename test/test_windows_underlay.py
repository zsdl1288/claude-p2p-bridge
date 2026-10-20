from pathlib import Path
import json
import os
import tempfile
import unittest
from unittest.mock import Mock, call, patch

from scripts import build_support, windows_underlay


class WindowsUnderlayBuildTests(unittest.TestCase):
    def setUp(self):
        validation = build_support.ROOT / '.cache/validation'
        validation.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix='underlay-policy-', dir=validation)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / 'source with spaces'
        (self.root / 'native').mkdir(parents=True)
        (self.root / 'native/go.mod').write_text('module fixture\n\ngo 1.27.1\n\nrequire tailscale.com v1.104.1\n')
        (self.root / 'native/go.sum').write_bytes(b'fixture checksums\n')
        self.env = {'GOMODCACHE': str(self.root / '.cache/gomod'), 'GOFLAGS': '-p=4'}
        self.upstream = Path(self.env['GOMODCACHE']) / ('tailscale.com@' + windows_underlay.TAILSCALE_VERSION)
        source_path = self.upstream / windows_underlay.UPSTREAM_RELATIVE
        source_path.parent.mkdir(parents=True)
        self.source = b'''// SPDX-License-Identifier: BSD-3-Clause
package netmon
// GetWindowsDefault returns the upstream default.
func GetWindowsDefault() { /* fixture */ }

func defaultRoute() {}
'''
        source_path.write_bytes(self.source)
        (self.upstream / 'go.mod').write_text('module tailscale.com\n')
        (self.upstream / 'net/netns').mkdir()
        (self.upstream / 'net/netns/netns_windows.go').write_text('package netns\n')
        policy = self.root / windows_underlay.POLICY_DIRECTORY
        policy.mkdir(parents=True)
        for name in windows_underlay.POLICY_FILES:
            (policy / name).write_bytes((build_support.ROOT / windows_underlay.POLICY_DIRECTORY / name).read_bytes())
        checksum = patch.object(windows_underlay, 'UPSTREAM_SHA256', windows_underlay.sha256(self.source))
        checksum.start()
        self.addCleanup(checksum.stop)

    def prepare(self):
        return windows_underlay.prepare_windows_underlay(self.root, self.env)

    def cache(self):
        return next((self.root / '.cache/windows-underlay').glob('*/receipt.json')).parent

    def test_copy_is_auditable_and_original_inputs_are_unchanged(self):
        mod_before = (self.root / 'native/go.mod').read_bytes()
        sum_before = (self.root / 'native/go.sum').read_bytes()
        result = self.prepare()
        cache = self.cache()
        self.assertEqual(result['GOFLAGS'], '-p=4 "-modfile=' + (cache / 'build.mod').as_posix() + '"')
        self.assertEqual((self.upstream / windows_underlay.UPSTREAM_RELATIVE).read_bytes(), self.source)
        self.assertEqual((self.root / 'native/go.mod').read_bytes(), mod_before)
        self.assertEqual((self.root / 'native/go.sum').read_bytes(), sum_before)
        self.assertEqual((cache / 'build.sum').read_bytes(), sum_before)
        self.assertIn('claudeBridgeDefaultUnderlay', (cache / 'tailscale.com' / windows_underlay.UPSTREAM_RELATIVE).read_text())
        self.assertIn('replace tailscale.com => ' + json.dumps((cache / 'tailscale.com').as_posix()), (cache / 'build.mod').read_text())
        self.assertEqual(self.prepare(), result, 'unchanged receipts must reuse the same generated copy')
        nested = windows_underlay.prepare_windows_underlay(self.root, result)
        self.assertEqual(nested, result, 'nested build preparation must reuse its verified policy flag without duplicating it')

    def test_upstream_drift_is_rejected_before_reusing_a_copy(self):
        self.prepare()
        (self.upstream / windows_underlay.UPSTREAM_RELATIVE).write_bytes(self.source + b'// changed\n')
        with self.assertRaisesRegex(ValueError, 'checksum changed'):
            self.prepare()

    def test_generated_cache_or_receipt_drift_is_rejected(self):
        for target in ('build.mod', 'tailscale.com/net/netmon/claude_bridge_underlay_windows.go',
                       'tailscale.com/net/netns/netns_windows.go', 'receipt.json'):
            with self.subTest(target=target):
                self.prepare()
                path = self.cache() / target
                original = path.read_bytes()
                path.write_bytes(original + b'changed')
                with self.assertRaisesRegex(ValueError, 'cache verification failed'):
                    self.prepare()
                path.write_bytes(original)

    def test_unexpected_or_missing_shadow_sources_are_rejected(self):
        self.prepare()
        unexpected = self.cache() / 'tailscale.com/net/netns/extra.go'
        unexpected.write_text('package netns\n')
        with self.assertRaisesRegex(ValueError, 'cache verification failed'):
            self.prepare()
        unexpected.unlink()
        missing = self.cache() / 'tailscale.com/net/netns/netns_windows.go'
        missing.unlink()
        with self.assertRaisesRegex(ValueError, 'cache verification failed'):
            self.prepare()

    def test_unreviewed_module_versions_and_replace_directives_are_rejected(self):
        path = self.root / 'native/go.mod'
        original = path.read_text()
        for module in (original.replace('v1.104.1', 'v1.104.2'), original + 'replace tailscale.com => ../other\n'):
            with self.subTest(module=module):
                path.write_text(module)
                with self.assertRaisesRegex(ValueError, 'requires|require review'):
                    self.prepare()
        path.write_text(original)

    def test_existing_modfile_and_overlay_flags_cannot_override_policy(self):
        for flags in ('-p=4 -modfile=other.mod', '"-modfile=path with spaces.mod"', '-overlay other.json'):
            with self.subTest(flags=flags), self.assertRaisesRegex(ValueError, 'conflicts'):
                windows_underlay.prepare_windows_underlay(self.root, {**self.env, 'GOFLAGS': flags})

    def test_all_windows_build_callers_share_policy_and_bootstrap_can_download_first(self):
        with patch.object(build_support, 'ROOT', self.root), patch.dict(os.environ, {'GOFLAGS': '-p=4', 'GOOS': 'windows'}, clear=True):
            env = build_support.go_environment()
            self.assertIn('-p=4', env['GOFLAGS'])
            self.assertIn('-modfile=', env['GOFLAGS'])
            (self.upstream / windows_underlay.UPSTREAM_RELATIVE).unlink()
            bootstrap = build_support.go_environment(offline=False, underlay_policy=False)
            self.assertEqual(bootstrap['GOFLAGS'], '-p=4')
            self.assertNotEqual(bootstrap['GOPROXY'], 'off')

    def test_source_package_contains_policy_generator_and_go_tests(self):
        names = {file.relative_to(build_support.ROOT).as_posix() for file in build_support.source_files()}
        self.assertTrue({'scripts/windows_underlay.py', 'native/_windows_underlay/netmon/underlay_windows.go',
                         'native/_windows_underlay/netmon/underlay_windows_test.go', 'test/test_windows_underlay.py'} <= names)


class PublishDirectoryTests(unittest.TestCase):
    @staticmethod
    def permission_error(code=None):
        error = PermissionError('fixture access denied')
        if code is not None:
            error.winerror = code
        return error

    def test_temporary_windows_sharing_failure_is_retried_then_succeeds(self):
        for code in (5, 32):
            with self.subTest(winerror=code):
                staging, destination = Mock(), object()
                staging.rename.side_effect = [self.permission_error(code), None]
                with patch.object(windows_underlay.sys, 'platform', 'win32'), \
                        patch.object(windows_underlay.time, 'sleep') as sleep:
                    windows_underlay.publish_directory(staging, destination)
                self.assertEqual(staging.rename.call_args_list, [call(destination)] * 2)
                sleep.assert_called_once_with(0.05)

    def test_permanent_windows_denial_is_bounded_and_propagates(self):
        staging, destination = Mock(), object()
        error = self.permission_error(5)
        staging.rename.side_effect = error
        with patch.object(windows_underlay.sys, 'platform', 'win32'), \
                patch.object(windows_underlay.time, 'sleep') as sleep:
            with self.assertRaises(PermissionError) as raised:
                windows_underlay.publish_directory(staging, destination)
        self.assertIs(raised.exception, error)
        self.assertEqual(staging.rename.call_args_list, [call(destination)] * 6)
        self.assertEqual(sleep.call_args_list, [call(0.05 * attempt) for attempt in range(1, 6)])
        self.assertLessEqual(sum(args.args[0] for args in sleep.call_args_list), 0.75)
        self.assertEqual(staging.mock_calls, [call.rename(destination)] * 6)

    def test_other_errors_and_non_windows_fail_without_retry(self):
        other = OSError('fixture I/O error')
        other.winerror = 5
        for platform, error in [('win32', self.permission_error()), ('win32', self.permission_error(13)),
                                ('win32', other), ('linux', self.permission_error(5))]:
            with self.subTest(platform=platform, error=type(error), winerror=getattr(error, 'winerror', None)):
                staging, destination = Mock(), object()
                staging.rename.side_effect = error
                with patch.object(windows_underlay.sys, 'platform', platform), \
                        patch.object(windows_underlay.time, 'sleep') as sleep:
                    with self.assertRaises(type(error)) as raised:
                        windows_underlay.publish_directory(staging, destination)
                self.assertIs(raised.exception, error)
                staging.rename.assert_called_once_with(destination)
                sleep.assert_not_called()


if __name__ == '__main__':
    unittest.main()
