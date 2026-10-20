import unittest
from scripts.test_support import FIXTURES, TemporaryTestDirectory, checked_fixture_path


class ScriptFixtureTests(unittest.TestCase):
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
