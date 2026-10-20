import unittest
from unittest.mock import patch
import os
import socket
from types import SimpleNamespace
from scripts import test_support
from scripts.test_support import FIXTURES, TemporaryTestDirectory, available_port_pair, checked_fixture_path, management_port


class ScriptFixtureTests(unittest.TestCase):
    @unittest.skipUnless(os.name == 'nt', 'Windows dynamic-port query')
    def test_dynamic_port_query_ignores_label_encoding_and_rejects_invalid_ranges(self):
        for output, expected in ((b'\xae\xff label: 10000\r\n\x81\xfe label: 55000\r\n', (10000, 64999)),
                                 (b'one field: 10000\n', None),
                                 (b'start: 10000\ncount: 999999\n', None)):
            with self.subTest(output=output), patch('scripts.test_support.subprocess.run', return_value=SimpleNamespace(stdout=output)):
                test_support._dynamic_tcp_range.cache_clear()
                try:
                    if expected is None:
                        with self.assertRaises(RuntimeError):
                            test_support._dynamic_tcp_range()
                    else:
                        self.assertEqual(test_support._dynamic_tcp_range(), expected)
                finally:
                    test_support._dynamic_tcp_range.cache_clear()

    def test_port_pair_avoids_dynamic_range_and_releases_both_sockets(self):
        with patch('scripts.test_support._dynamic_tcp_range', return_value=(30000, 65535)), \
             patch('scripts.test_support.secrets.randbelow', side_effect=lambda count: count - 1):
            port = available_port_pair()
        self.assertLess(port + 1, 30000)
        with socket.socket() as model, socket.socket() as management:
            model.bind(('127.0.0.1', port))
            management.bind(('127.0.0.1', management_port(port)))

    def test_port_pair_skips_an_occupied_management_listener(self):
        with patch('scripts.test_support._dynamic_tcp_range', return_value=(30000, 65535)):
            first = available_port_pair()
            with socket.socket() as occupied:
                occupied.bind(('127.0.0.1', first + 1))
                with patch('scripts.test_support.secrets.randbelow', return_value=first - 1024):
                    replacement = available_port_pair()
            self.assertNotIn(first + 1, (replacement, management_port(replacement)))

    def test_management_port_boundary_does_not_overflow(self):
        self.assertEqual(management_port(3210), 3211)
        self.assertEqual(management_port(65535), 65534)

    def test_port_pair_random_choice_spans_both_sides_of_dynamic_range(self):
        with patch('scripts.test_support._dynamic_tcp_range', return_value=(10000, 64999)), \
             patch('scripts.test_support.socket.socket'):
            with patch('scripts.test_support.secrets.randbelow', return_value=0):
                below = available_port_pair()
            with patch('scripts.test_support.secrets.randbelow', side_effect=lambda count: count - 1):
                above = available_port_pair()
        self.assertLess(below + 1, 10000)
        self.assertGreater(above, 64999)

    def test_success_and_failure_remove_only_the_current_run(self):
        with TemporaryTestDirectory("fixture-neighbour-") as neighbour:
            sentinel = neighbour / "keep.txt"
            sentinel.write_text("other fixture", encoding="utf-8")
            with TemporaryTestDirectory("fixture-success-") as successful:
                (successful / "temporary.txt").write_text("test", encoding="utf-8")
            self.assertFalse(successful.exists())
            with self.assertRaisesRegex(RuntimeError, "intentional test failure"):
                with TemporaryTestDirectory("fixture-failure-") as failed:
                    raise RuntimeError("intentional test failure")
            self.assertFalse(failed.exists())
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "other fixture")
        self.assertFalse(neighbour.exists())

    def test_cleanup_is_idempotent(self):
        fixture = TemporaryTestDirectory("fixture-repeat-")
        fixture.cleanup()
        fixture.cleanup()
        self.assertFalse(fixture.path.exists())

    def test_rejects_the_root_external_or_traversing_paths(self):
        for target in (FIXTURES, FIXTURES.parent, FIXTURES.parent / "bin",
                       FIXTURES / ".." / "outside", FIXTURES / "nested" / ".." / "other"):
            with self.subTest(target=target), self.assertRaises(ValueError):
                checked_fixture_path(target)
        with self.assertRaises(ValueError):
            TemporaryTestDirectory("../unsafe-")

    def test_cleanup_refuses_linked_content_without_touching_its_target(self):
        with TemporaryTestDirectory("fixture-link-target-") as target:
            sentinel = target / "keep.txt"
            sentinel.write_text("preserve", encoding="utf-8")
            fixture = TemporaryTestDirectory("fixture-linked-")
            link = fixture.path / "linked"
            try:
                try:
                    link.symlink_to(target, target_is_directory=True)
                except OSError:
                    self.skipTest("Windows symlink creation is unavailable")
                with self.assertRaisesRegex(ValueError, "Linked"):
                    fixture.cleanup()
                self.assertEqual(sentinel.read_text(encoding="utf-8"), "preserve")
            finally:
                if link.is_symlink():
                    link.unlink()
                fixture.cleanup()


if __name__ == "__main__":
    unittest.main()
