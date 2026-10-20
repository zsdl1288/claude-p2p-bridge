from pathlib import Path
import hashlib
import json
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET
from scripts.build_support import ROOT, VERSION, runtime_files, source_files, source_manifest, write_manifest
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

    def test_source_archive_excludes_private_state_binaries_and_old_launcher(self):
        names = {file.relative_to(ROOT).as_posix() for file in source_files()}
        self.assertNotIn('start.cmd', names)
        self.assertNotIn('native/cmd/bridge/runtime.zip', names)
        self.assertTrue({'src/version.js', 'scripts/build_support.py', 'native/desktop/app.manifest'} <= names)
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
        return executable

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
        target, _, verified = package_source(root, '1.2.3')
        self.assertFalse(verified)
        first = target.read_bytes()
        with patch('scripts.package.zipfile.ZipFile.writestr', side_effect=OSError('synthetic disk failure')):
            with self.assertRaisesRegex(OSError, 'disk failure'):
                package_source(root, '1.2.3')
        self.assertEqual(target.read_bytes(), first)
        self.assertEqual(list((root / 'release').glob('*.tmp')), [])

    def test_lockfile_version_mismatch_is_rejected(self):
        root = self.fixture()
        (root / 'package-lock.json').write_text(json.dumps({'version': '1.2.2'}))
        with self.assertRaisesRegex(ValueError, 'versions must match'):
            package_source(root, '1.2.3')
