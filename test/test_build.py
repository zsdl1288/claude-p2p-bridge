from pathlib import Path
import hashlib
import json
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET
import zipfile
from scripts import build_support
from scripts.build_support import ROOT, VERSION, module_license_files, runtime_files, source_files, source_manifest, write_manifest
from scripts.package import package_source


class ReleasePolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        (ROOT / '.bridge').mkdir(exist_ok=True)

    def test_manifest_has_current_release_identity(self):
        with tempfile.TemporaryDirectory(prefix='build-policy-', dir=ROOT / '.bridge') as directory:
            target = Path(directory) / 'app.manifest'
            write_manifest(target)
            identity = ET.parse(target).getroot().find('{urn:schemas-microsoft-com:asm.v1}assemblyIdentity')
            self.assertEqual(identity.attrib['version'], VERSION + '.0')

    def test_module_licenses_keep_documents_without_go_test_sources(self):
        with tempfile.TemporaryDirectory(prefix='module-license-') as directory:
            root = Path(directory)
            documents = {'LICENSE', 'LICENSE.BSD-2-Clause', 'LICENSE.md', 'LICENSE.txt',
                         'LICENSE-MIT', 'COPYING', 'COPYING.LESSER', 'NOTICE', 'AUTHORS', 'PATENTS'}
            for name in documents | {'license_test.go', 'licenses.go', 'license.go',
                                     'LICENSE-MIT.go', 'NOTICE.GO', 'README.md'}:
                (root / name).write_text('fixture')
            (root / 'NOTICE.txt').mkdir()
            self.assertEqual([file.name for file in module_license_files(root)], sorted(documents))

    def test_source_archive_excludes_private_state_binaries_and_old_launcher(self):
        names = {file.relative_to(ROOT).as_posix() for file in source_files()}
        self.assertNotIn('start.cmd', names)
        self.assertNotIn('native/cmd/bridge/runtime.zip', names)
        self.assertTrue({'src/version.js', 'scripts/build_support.py', 'native/desktop/app.manifest', 'test/update-release.rc'} <= names)
        self.assertFalse(any(name.endswith(('.exe', '.pyc')) or '.bridge/' in name for name in names))

    def test_linked_source_cannot_escape_the_archive_root(self):
        with tempfile.TemporaryDirectory(prefix='build-policy-', dir=ROOT / '.bridge') as directory:
            root = Path(directory)
            for name in ('src', 'public', 'scripts', 'test', 'examples', 'native'):
                (root / name).mkdir()
            for name in ('package.json', 'package-lock.json', 'README.md', '.gitignore'):
                (root / name).write_text('fixture')
            target = root / 'outside.txt'
            target.write_text('not a source file')
            link = root / 'src/linked.js'
            try:
                link.symlink_to(target)
            except OSError:
                self.skipTest('Windows symlink creation is unavailable')
            with self.assertRaisesRegex(ValueError, 'Linked or external'):
                source_files(root)

    def test_missing_required_release_files_and_directories_fail_early(self):
        with tempfile.TemporaryDirectory(prefix='build-policy-', dir=ROOT / '.bridge') as directory:
            root = Path(directory)
            with self.assertRaisesRegex(FileNotFoundError, 'Required release file'):
                source_files(root)
            for name in ('package.json', 'package-lock.json', 'README.md', '.gitignore'):
                (root / name).write_text('fixture')
            with self.assertRaisesRegex(FileNotFoundError, 'Required release directory'):
                source_files(root)

    def test_embedded_runtime_excludes_stray_private_files_and_build_artifacts(self):
        with tempfile.TemporaryDirectory(prefix='build-policy-', dir=ROOT / '.bridge') as directory:
            root = Path(directory)
            fixtures = {
                'package.json', 'package-lock.json', 'node_modules/ws/LICENSE',
                'src/main.js', 'src/model-api.js', 'public/app.js', 'public/index.html',
                'public/styles.css', 'public/licenses.txt', 'node_modules/ws/wrapper.mjs',
                'node_modules/ws/index.js', 'node_modules/ws/lib/websocket.js', 'node_modules/ws/package.json',
                'src/.env.local', 'public/.env', 'src/.bridge/pairing.dat', 'public/api-token',
                'public/desktop.ini', 'public/proxy.json', 'src/proxy-demo.json', 'src/__pycache__/stale.pyc', 'src/unexpected.exe',
                'public/Proxy.json', 'src/.ENV.local', 'src/.Bridge/private.js',
                'node_modules/ws/.env.local', 'node_modules/ws/README.md', 'scripts/build_windows.py'
            }
            for name in fixtures:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('fixture')
            names = {file.relative_to(root).as_posix() for file in runtime_files(root)}
            self.assertEqual(names, {
                'package.json', 'package-lock.json', 'node_modules/ws/LICENSE',
                'src/main.js', 'src/model-api.js', 'public/app.js', 'public/index.html',
                'public/styles.css', 'public/licenses.txt', 'node_modules/ws/wrapper.mjs', 'node_modules/ws/index.js',
                'node_modules/ws/lib/websocket.js', 'node_modules/ws/package.json'
            })


class SourcePackagingTests(unittest.TestCase):
    def fixture(self):
        (ROOT / '.bridge').mkdir(exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix='package-test-', dir=ROOT / '.bridge')
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        for name in ('src', 'public', 'scripts', 'test', 'examples', 'native', 'release'):
            (root / name).mkdir()
        (root / 'package.json').write_text(json.dumps({'version': '1.2.3'}))
        (root / 'package-lock.json').write_text(json.dumps({'version': '1.2.3', 'packages': {'': {'version': '1.2.3'}}}))
        (root / 'README.md').write_text('Test source')
        (root / '.gitignore').write_text('.bridge/')
        (root / 'src/main.js').write_text('export const ready = true;')
        return root

    def record(self, root):
        executable = root / 'release/ClaudeBridge-1.2.3-windows-x64.exe'
        executable.write_bytes(b'compiled fixture')
        record = {'v': 1, 'version': '1.2.3', 'executable': executable.name,
                  'sha256': hashlib.sha256(executable.read_bytes()).hexdigest(), 'sources': source_manifest(root)}
        executable.with_suffix('.build.json').write_text(json.dumps(record))
        executable.with_suffix('.sha256.txt').write_text(f'{record["sha256"]}  {executable.name}\n')
        return executable

    def older_artifacts(self, root):
        names = ('ClaudeBridge-1.2.2-windows-x64.exe',
                 'ClaudeBridge-1.2.2-windows-x64.sha256.txt',
                 'ClaudeBridge-1.2.2-windows-x64.build.json',
                 'claude-p2p-bridge-1.2.2.zip')
        files = {root / 'release' / name: f'older fixture: {name}'.encode() for name in names}
        for file, data in files.items():
            file.write_bytes(data)
        return files

    def assert_preserved(self, files):
        for file, data in files.items():
            self.assertEqual(file.read_bytes(), data, file.name)

    def recovery_archive(self, root):
        executable = 'ClaudeBridge-Network-Recovery-windows-x64.exe'
        data = b'MZ synthetic recovery fixture'
        members = {executable: data,
                   'ClaudeBridge-Network-Recovery-windows-x64.sha256.txt':
                       f'{hashlib.sha256(data).hexdigest()}  {executable}\n'.encode(),
                   'NETWORK-RECOVERY-README.txt':
                       b'Offline recovery fixture. Run the recovery EXE as administrator and enter RESTORE.'}
        target = root / 'release/ClaudeBridge-Network-Recovery-windows-x64.zip'
        with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
            for name, content in members.items():
                archive.writestr(name, content)
        return target, members

    def test_reproducible_archive_matches_binary_build_record(self):
        root = self.fixture()
        self.record(root)
        target, count, verified = package_source(root, '1.2.3')
        first = target.read_bytes()
        self.assertTrue(verified)
        self.assertEqual(count, len(source_manifest(root)))
        package_source(root, '1.2.3')
        self.assertEqual(target.read_bytes(), first)

    def test_changed_source_or_binary_cannot_overwrite_verified_archive(self):
        root = self.fixture()
        executable = self.record(root)
        target, _, _ = package_source(root, '1.2.3')
        first = target.read_bytes()
        (root / 'README.md').write_text('different source')
        with self.assertRaisesRegex(ValueError, 'build record'):
            package_source(root, '1.2.3')
        self.assertEqual(target.read_bytes(), first)
        (root / 'README.md').write_text('Test source')
        executable.write_bytes(b'changed binary')
        with self.assertRaisesRegex(ValueError, 'build record'):
            package_source(root, '1.2.3')
        self.assertEqual(target.read_bytes(), first)

    def test_interrupted_write_keeps_previous_archive_and_cleans_temporary_file(self):
        root = self.fixture()
        self.record(root)
        target, _, verified = package_source(root, '1.2.3')
        self.assertTrue(verified)
        first = target.read_bytes()
        older = self.older_artifacts(root)
        with patch('scripts.package.zipfile.ZipFile.writestr', side_effect=OSError('synthetic disk failure')):
            with self.assertRaisesRegex(OSError, 'disk failure'):
                package_source(root, '1.2.3')
        self.assertEqual(target.read_bytes(), first)
        self.assert_preserved(older)
        self.assertEqual(list((root / 'release').glob('*.tmp')), [])

    def test_verified_package_keeps_only_current_release_and_valid_recovery_archive(self):
        root = self.fixture()
        executable = self.record(root)
        self.older_artifacts(root)
        recovery, members = self.recovery_archive(root)
        for name, content in members.items():
            (root / 'release' / name).write_bytes(content)
        target, _, verified = package_source(root, '1.2.3')
        self.assertTrue(verified)
        self.assertEqual({file.name for file in (root / 'release').iterdir()}, {
            executable.name, executable.with_suffix('.sha256.txt').name,
            executable.with_suffix('.build.json').name, target.name, recovery.name})
        with zipfile.ZipFile(target) as archive:
            self.assertIsNone(archive.testzip())
            self.assertEqual({name.removeprefix('claude-p2p-bridge-1.2.3/'): hashlib.sha256(archive.read(name)).hexdigest()
                              for name in archive.namelist()}, source_manifest(root))

    def test_missing_or_incorrect_current_checksum_never_deletes_older_artifacts(self):
        for condition in ('missing', 'incorrect'):
            with self.subTest(condition=condition):
                root = self.fixture()
                executable = self.record(root)
                older = self.older_artifacts(root)
                checksum = executable.with_suffix('.sha256.txt')
                if condition == 'missing':
                    checksum.unlink()
                else:
                    checksum.write_text(f'{"0" * 64}  {executable.name}\n')
                with self.assertRaises((ValueError, FileNotFoundError)):
                    package_source(root, '1.2.3')
                self.assert_preserved(older)

    def test_repackaging_an_older_version_preserves_all_existing_release_artifacts(self):
        root = self.fixture()
        self.record(root)
        preserved = self.older_artifacts(root)
        future = root / 'release/ClaudeBridge-1.10.0-windows-x64.exe'
        future.write_bytes(b'future release fixture')
        preserved[future] = future.read_bytes()
        self.assertTrue(package_source(root, '1.2.3')[2])
        self.assert_preserved(preserved)

    def test_cleanup_keeps_unknown_files_directories_and_unmatched_recovery_files(self):
        root = self.fixture()
        self.record(root)
        older = self.older_artifacts(root)
        _, members = self.recovery_archive(root)
        preserved = {
            root / 'release/notes.txt': b'keep operator notes',
            root / 'release/ClaudeBridge-preview-windows-x64.exe': b'unknown fixture',
            root / 'release/diagnostics/session.log': b'keep diagnostics',
            root / 'release/ClaudeBridge-0.1.0-windows-x64.exe/keep.txt': b'keep artifact-shaped directory',
            root / 'release/NETWORK-RECOVERY-README.txt': b'local guide differs from archived guide',
        }
        self.assertNotEqual(preserved[root / 'release/NETWORK-RECOVERY-README.txt'], members['NETWORK-RECOVERY-README.txt'])
        for file, data in preserved.items():
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(data)
        package_source(root, '1.2.3')
        self.assert_preserved(preserved)
        self.assertTrue(all(not file.exists() for file in older))

    def test_linked_release_directory_or_file_is_rejected_before_cleanup(self):
        for kind in ('directory', 'file'):
            with self.subTest(kind=kind):
                root = self.fixture()
                self.record(root)
                package_source(root, '1.2.3')
                older = self.older_artifacts(root)
                if kind == 'directory':
                    target = root / 'saved-release'
                    (root / 'release').rename(target)
                    link = root / 'release'
                else:
                    target = root / 'outside.txt'
                    target.write_bytes(b'preserve external fixture')
                    link = root / 'release/linked-file.txt'
                try:
                    link.symlink_to(target, target_is_directory=kind == 'directory')
                except OSError:
                    self.skipTest('Windows symlink creation is unavailable')
                with self.assertRaisesRegex(ValueError, 'Linked or external'):
                    build_support.cleanup_release(root, '1.2.3', source_manifest(root))
                self.assert_preserved(older)
                self.assertTrue(link.is_symlink())
                if kind == 'file':
                    self.assertEqual(target.read_bytes(), b'preserve external fixture')

    def test_source_snapshot_without_a_build_record_does_not_cleanup_release(self):
        root = self.fixture()
        older = self.older_artifacts(root)
        _, _, verified = package_source(root, '1.2.3')
        self.assertFalse(verified)
        self.assert_preserved(older)

    def test_invalid_current_source_or_recovery_archive_prevents_all_cleanup(self):
        for artifact in ('source', 'recovery'):
            with self.subTest(artifact=artifact):
                root = self.fixture()
                self.record(root)
                source, _, _ = package_source(root, '1.2.3')
                older = self.older_artifacts(root)
                if artifact == 'source':
                    with zipfile.ZipFile(source, 'w') as archive:
                        archive.writestr('claude-p2p-bridge-1.2.3/README.md', b'wrong source fixture')
                else:
                    recovery, _ = self.recovery_archive(root)
                    recovery.write_bytes(b'not a valid recovery ZIP')
                with self.assertRaises((ValueError, zipfile.BadZipFile)):
                    build_support.cleanup_release(root, '1.2.3', source_manifest(root))
                self.assert_preserved(older)

    def test_lockfile_version_mismatch_is_rejected(self):
        root = self.fixture()
        (root / 'package-lock.json').write_text(json.dumps({'version': '1.2.2'}))
        with self.assertRaisesRegex(ValueError, 'versions must match'):
            package_source(root, '1.2.3')
