"""Exercise native exit/crash logging using disposable subprocess profiles only.

Run: python -m unittest test.test_lifecycle -v
No production executable is launched and no live Bridge profile is accessed.
"""
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parent.parent
SECRET = "fixture-secret-must-not-be-logged"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def linked(path):
    return path.is_symlink() or (path.exists() and
        getattr(path.lstat(), "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))


def checked_cache():
    cache = ROOT / ".cache" / "lifecycle-tests"
    for entry in (cache, *cache.parents):
        if linked(entry):
            raise RuntimeError(f"Refusing linked test cache: {entry}")
        if entry == ROOT:
            break
    cache.mkdir(parents=True, exist_ok=True)
    return cache


@unittest.skipUnless(os.name == "nt", "Native lifecycle hooks require Windows")
class LifecycleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        compiler = ROOT / ".tools/w64devkit/bin/g++.exe"
        if not compiler.is_file():
            raise RuntimeError(f"Portable C++ compiler is missing: {compiler}")
        cls.temporary = tempfile.TemporaryDirectory(prefix="run-", dir=checked_cache())
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.work = Path(cls.temporary.name)
        cls.executable = cls.work / "lifecycle-test.exe"
        env = os.environ.copy()
        env["PATH"] = str(compiler.parent) + os.pathsep + env.get("PATH", "")
        subprocess.run([str(compiler), "-std=c++20", "-O2", "-static", "-static-libgcc",
                        "-static-libstdc++", "-municode", "-Wall", "-Wextra",
                        str(ROOT / "test/lifecycle.cpp"), "-o", str(cls.executable),
                        "-lbcrypt", "-ladvapi32", "-luser32", "-lshell32", "-lwinhttp"],
                       env=env, check=True, timeout=120, creationflags=NO_WINDOW)

    def setUp(self):
        self.case = Path(tempfile.mkdtemp(prefix="case-", dir=self.work))
        self.profile = self.case / "profile"
        self.logs = self.profile / "diagnostics/lifecycle"

    def launch(self, mode="normal", profile=None, limit=None, check=True):
        profile = profile or self.profile
        profile.mkdir(parents=True, exist_ok=True)
        command = [str(self.executable), mode, str(profile)]
        if limit is not None:
            command.append(str(limit))
        return subprocess.run(command, check=check, capture_output=True, text=True,
                              timeout=15, creationflags=NO_WINDOW)

    def read_state(self):
        return json.loads((self.logs / "desktop-state.json").read_text(encoding="utf-8"))

    def records(self, stem="desktop"):
        values = []
        for suffix in (".2", ".1", ""):
            path = self.logs / (stem + ".jsonl" + suffix)
            if path.exists():
                for line in path.read_text(encoding="utf-8").splitlines():
                    self.assertTrue(line, f"Empty JSONL record in {path.name}")
                    values.append(json.loads(line))
        return values

    def event(self, name, stem="desktop"):
        return [entry for entry in self.records(stem) if entry.get("event") == name]

    def linger(self):
        self.profile.mkdir(parents=True, exist_ok=True)
        process = subprocess.Popen([str(self.executable), "linger", str(self.profile)],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                   creationflags=NO_WINDOW)
        def stop():
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=5)
        self.addCleanup(stop)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if process.poll() is not None:
                self.fail(f"Linger fixture exited early: {process.communicate()}")
            try:
                state = self.read_state()
                if state.get("pid") == process.pid:
                    return process, state
            except (FileNotFoundError, json.JSONDecodeError):
                pass
            time.sleep(0.02)
        self.fail("Linger fixture did not persist its startup marker")

    def test_normal_exit_is_complete_and_does_not_report_unclean_next_start(self):
        result = self.launch()
        info = json.loads(result.stdout)
        state = self.read_state()
        self.assertTrue(info["started"])
        self.assertEqual(state["v"], 1)
        self.assertTrue(state["completed"])
        self.assertEqual(state["sessionId"], info["sessionId"])
        self.assertEqual(state["pid"], info["pid"])
        self.assertEqual(state["version"], "fixture-1.0.0")
        self.assertTrue(state["startedAtUtc"])
        self.assertIsInstance(state["createdFileTime"], str)
        self.assertTrue(state["createdFileTime"].isdigit())
        self.assertEqual(state["reason"], "user-exit")
        self.assertEqual(state["exitCode"], 0)
        self.assertEqual(len(self.event("session-ended")), 1)
        next_info = json.loads(self.launch().stdout)
        self.assertNotEqual(info["sessionId"], next_info["sessionId"])
        self.assertEqual(self.event("previous-session-incomplete"), [])
        self.assertEqual(self.records("desktop-crash"), [])

    def test_terminate_process_is_reported_next_start_without_inventing_a_crash(self):
        process, previous = self.linger()
        self.assertFalse(previous["completed"])
        process.kill()  # Windows Popen.kill is TerminateProcess.
        process.communicate(timeout=5)
        self.assertFalse(self.read_state()["completed"])
        self.assertEqual(self.records("desktop-crash"), [])
        self.launch()
        incomplete = self.event("previous-session-incomplete")
        self.assertEqual(len(incomplete), 1)
        entry = incomplete[0]
        details = entry.get("details", entry)
        self.assertEqual(details["reason"], "no-completion-record")
        self.assertEqual(details["previousPid"], process.pid)
        self.assertEqual(details["previousSessionId"], previous["sessionId"])
        self.assertEqual(self.records("desktop-crash"), [])

    def test_a_live_previous_process_is_not_claimed_to_have_crashed(self):
        self.linger()
        self.launch()
        self.assertEqual(self.event("previous-session-incomplete"), [])
        self.assertEqual(self.records("desktop-crash"), [])

    def test_unhandled_windows_exception_records_code_and_keeps_incomplete_marker(self):
        result = self.launch("seh", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.read_state()["completed"])
        fatal = self.event("fatal", "desktop-crash")
        self.assertEqual(len(fatal), 1)
        details = fatal[0].get("details", fatal[0])
        self.assertEqual(details["reason"], "windows-unhandled-exception")
        self.assertEqual(details["exceptionCode"], 0xE0424242)
        self.assertIsInstance(details["exceptionAddress"], int)
        self.assertEqual(self.event("session-ended"), [])
        self.launch()
        self.assertEqual(len(self.event("previous-session-incomplete")), 1)

    def test_cpp_terminate_records_fatal_and_keeps_incomplete_marker(self):
        result = self.launch("terminate", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.read_state()["completed"])
        fatal = self.event("fatal", "desktop-crash")
        self.assertEqual(len(fatal), 1)
        details = fatal[0].get("details", fatal[0])
        self.assertEqual(details["reason"], "cpp-terminate")
        self.assertEqual(details["exceptionCode"], 0xE0000001)
        self.assertEqual(self.event("session-ended"), [])

    def test_private_arbitrary_details_are_omitted_and_jsonl_rotates_at_bound(self):
        limit = 2048
        self.launch("rotate", limit=limit)
        files = list(self.logs.glob("desktop.jsonl*"))
        self.assertEqual({path.name for path in files},
                         {"desktop.jsonl", "desktop.jsonl.1", "desktop.jsonl.2"})
        for path in files:
            self.assertLessEqual(path.stat().st_size, limit, path.name)
            self.assertNotIn(SECRET, path.read_text(encoding="utf-8"))
        self.assertGreater(len(self.records()), 3)
        self.assertEqual(len(self.event("session-ended")), 1)
        self.assertTrue(self.read_state()["completed"])
        # Also inspect an unrotated file so eviction cannot hide a privacy bug.
        self.launch(profile=self.case / "privacy")
        for path in (self.case / "privacy/diagnostics/lifecycle").iterdir():
            if path.is_file():
                self.assertNotIn(SECRET, path.read_text(encoding="utf-8"))

    def test_crash_journal_rotates_without_partial_or_oversized_records(self):
        limit = 2048
        for _ in range(20):
            self.assertNotEqual(self.launch("seh", limit=limit, check=False).returncode, 0)
        files = list(self.logs.glob("desktop-crash.jsonl*"))
        self.assertEqual({path.name for path in files},
                         {"desktop-crash.jsonl", "desktop-crash.jsonl.1", "desktop-crash.jsonl.2"})
        for path in files:
            self.assertLessEqual(path.stat().st_size, limit, path.name)
        fatal = self.records("desktop-crash")
        self.assertGreater(len(fatal), 2)
        self.assertLess(len(fatal), 20)
        self.assertTrue(all(row.get("event") == "fatal" for row in fatal))
        self.assertFalse(self.read_state()["completed"])

    def test_invalid_directory_and_exclusively_locked_log_fail_without_throwing(self):
        self.profile.mkdir()
        (self.profile / "diagnostics").write_text("ordinary file", encoding="utf-8")
        self.assertFalse(json.loads(self.launch("probe").stdout)["started"])
        self.assertEqual((self.profile / "diagnostics").read_text(), "ordinary file")
        other = self.case / "locked"
        logs = other / "diagnostics/lifecycle"
        logs.mkdir(parents=True)
        sentinel = logs / "desktop.jsonl"
        sentinel.write_text("unchanged", encoding="utf-8")
        self.launch("locked", profile=other)
        self.assertEqual(sentinel.read_text(), "unchanged")

    def test_hardlinked_final_files_do_not_modify_the_other_name(self):
        for name in ("desktop.jsonl", "desktop-crash.jsonl", "desktop-state.json",
                     "desktop.jsonl.1", "desktop.jsonl.2", "desktop-crash.jsonl.1", "desktop-crash.jsonl.2"):
            with self.subTest(name=name):
                profile = self.case / name.replace(".", "-")
                logs = profile / "diagnostics/lifecycle"
                logs.mkdir(parents=True)
                sentinel = self.case / (name + ".outside")
                sentinel.write_text("outside-hardlink-sentinel", encoding="utf-8")
                os.link(sentinel, logs / name)
                self.launch("probe", profile=profile)
                self.assertEqual(sentinel.read_text(), "outside-hardlink-sentinel")

    def test_directory_junctions_do_not_redirect_log_writes(self):
        for component in ("profile", "diagnostics", "lifecycle"):
            with self.subTest(component=component):
                base = self.case / component
                outside = base / "outside"
                outside.mkdir(parents=True)
                profile = base / "profile"
                link = {"profile": profile, "diagnostics": profile / "diagnostics",
                        "lifecycle": profile / "diagnostics/lifecycle"}[component]
                link.parent.mkdir(parents=True, exist_ok=True)
                result = subprocess.run(["cmd", "/d", "/c", "mklink", "/J", str(link), str(outside)],
                                        capture_output=True, text=True, creationflags=NO_WINDOW, timeout=5)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                try:
                    self.assertFalse(json.loads(self.launch("probe", profile=profile).stdout)["started"])
                    self.assertEqual(list(outside.iterdir()), [])
                finally:
                    # Remove the junction itself before normal fixture cleanup.
                    os.rmdir(link)


if __name__ == "__main__":
    unittest.main()
