package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"

	"golang.org/x/sys/windows"
)

func readLifecycleRows(t *testing.T, directory, component string) []lifecycleRecord {
	t.Helper()
	root, closeRoot, err := openLifecycleRoot(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer closeRoot()
	file, err := checkedLifecycleFile(root, component+".jsonl", os.O_RDONLY)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	var result []lifecycleRecord
	decoder := json.NewDecoder(file)
	for decoder.More() {
		var row lifecycleRecord
		if err := decoder.Decode(&row); err != nil {
			t.Fatal(err)
		}
		result = append(result, row)
	}
	return result
}

func TestLifecycleSessionAndEnvironmentDoNotPersistUntrustedValues(t *testing.T) {
	secret := "fixture-secret\nBearer token"
	t.Setenv("BRIDGE_LIFECYCLE_SESSION", secret)
	log := newLifecycleLog(t.TempDir(), "engine")
	if len(log.session) != 32 || strings.Contains(log.session, "secret") {
		t.Fatalf("invalid session was retained: %q", log.session)
	}
	for _, invalid := range []string{"", "with_underscore", strings.Repeat("a", 97), "中文"} {
		if value := lifecycleSession(invalid); len(value) != 32 || value == invalid {
			t.Fatalf("invalid session accepted: %q", invalid)
		}
	}
	if value := lifecycleSession("desktop-123"); value != "desktop-123" {
		t.Fatal("safe desktop session was not inherited")
	}
	env := lifecycleEnvironment([]string{"KEEP=ok", "bridge_lifecycle_session=" + secret, "BRIDGE_LIFECYCLE_DIRECTORY=old"}, log, log.directory)
	if len(env) != 3 || env[0] != "KEEP=ok" || env[1] != "BRIDGE_LIFECYCLE_SESSION="+log.session ||
		env[2] != "BRIDGE_LIFECYCLE_DIRECTORY="+log.directory {
		t.Fatalf("unexpected lifecycle environment: %q", env)
	}
	log.record("launch", "process-start", lifecycleFields{})
	log.startupFailure("node-start", fmt.Errorf("%s: %w", secret, syscall.Errno(5)))
	log.record("launch", secret, lifecycleFields{}) // Not an allowed event reason.
	rows := readLifecycleRows(t, log.directory, "engine")
	if len(rows) != 2 || rows[0].V != 1 || rows[0].Version != version || rows[1].Version != version || rows[0].Component != "engine" || rows[0].PID != os.Getpid() ||
		rows[0].UTC == "" || rows[1].Win32Code == nil || *rows[1].Win32Code != 5 {
		t.Fatalf("unexpected lifecycle facts: %+v", rows)
	}
	data, _ := json.Marshal(rows)
	if bytes.Contains(data, []byte("fixture-secret")) || bytes.Contains(data, []byte("Bearer")) {
		t.Fatal("untrusted input or error text reached lifecycle logs")
	}
}

func TestLifecycleRotationIsBoundedAndPreservesOtherFiles(t *testing.T) {
	directory := t.TempDir()
	log := newLifecycleLog(directory, "engine")
	log.record("launch", "process-start", lifecycleFields{})
	root, closeRoot, err := openLifecycleRoot(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer closeRoot()
	for _, suffix := range []string{"", ".1", ".2"} {
		file, err := checkedLifecycleFile(root, "engine.jsonl"+suffix, os.O_WRONLY|os.O_CREATE)
		if err != nil {
			t.Fatal(err)
		}
		if err := file.Truncate(lifecycleMaximumBytes); err != nil {
			t.Fatal(err)
		}
		_ = file.Close()
	}
	kept := filepath.Join(directory, "diagnostics", "lifecycle", "user-notes.txt")
	if err := os.WriteFile(kept, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	log.record("end", "node-exited", lifecycleFields{})
	for _, suffix := range []string{"", ".1", ".2"} {
		info, err := root.Stat("engine.jsonl" + suffix)
		if err != nil || info.Size() > lifecycleMaximumBytes {
			t.Fatalf("unbounded lifecycle file %s: %v %v", suffix, info, err)
		}
	}
	if _, err := root.Lstat("engine.jsonl.3"); !os.IsNotExist(err) {
		t.Fatal("more than two rotations were retained", err)
	}
	if content, err := os.ReadFile(kept); err != nil || string(content) != "keep" {
		t.Fatal("rotation changed an unrelated file", err)
	}
	rows := readLifecycleRows(t, directory, "engine")
	if len(rows) != 1 || rows[0].Event != "end" {
		t.Fatalf("new rotation does not contain the completed record: %+v", rows)
	}
}

func TestLifecycleConcurrentRecordsRemainValid(t *testing.T) {
	directory := t.TempDir()
	log := newLifecycleLog(directory, "network")
	var pending sync.WaitGroup
	for range 12 {
		pending.Go(func() {
			for range 8 {
				log.record("launch", "process-start", lifecycleFields{})
			}
		})
	}
	pending.Wait()
	if rows := readLifecycleRows(t, directory, "network"); len(rows) != 96 {
		t.Fatalf("concurrent records lost or corrupted: %d", len(rows))
	}
}

func TestLifecycleRejectsJunctionsAtEveryDirectoryLevel(t *testing.T) {
	for _, kind := range []string{"ancestor", "profile", "diagnostics", "lifecycle", "current-file", "rotated-file"} {
		t.Run(kind, func(t *testing.T) {
			directory, outside := t.TempDir(), t.TempDir()
			kept := filepath.Join(outside, "keep.txt")
			if err := os.WriteFile(kept, []byte("external-data"), 0600); err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "ancestor":
				child := filepath.Join(outside, "profile")
				if err := os.Mkdir(child, 0700); err != nil {
					t.Fatal(err)
				}
				link := filepath.Join(directory, "linked")
				runtimeJunction(t, link, outside)
				directory = filepath.Join(link, "profile")
			case "profile":
				link := filepath.Join(directory, "linked")
				runtimeJunction(t, link, outside)
				directory = link
			default:
				relative := "diagnostics"
				if kind != "diagnostics" {
					relative = filepath.Join(relative, "lifecycle")
				}
				if kind == "current-file" {
					relative = filepath.Join(relative, "engine.jsonl")
				}
				if kind == "rotated-file" {
					relative = filepath.Join(relative, "engine.jsonl.1")
				}
				link := filepath.Join(directory, relative)
				if err := os.MkdirAll(filepath.Dir(link), 0700); err != nil {
					t.Fatal(err)
				}
				runtimeJunction(t, link, outside)
			}
			newLifecycleLog(directory, "engine").record("launch", "process-start", lifecycleFields{})
			if content, err := os.ReadFile(kept); err != nil || string(content) != "external-data" {
				t.Fatal("lifecycle write changed an external file", err)
			}
			entries, err := os.ReadDir(outside)
			if err != nil {
				t.Fatal(err)
			}
			expected := 1
			if kind == "ancestor" {
				expected = 2
			}
			if len(entries) != expected {
				t.Fatal("lifecycle write followed a junction")
			}
		})
	}
}

func TestLifecycleRejectsFinalFileHardlinks(t *testing.T) {
	directory, outside := t.TempDir(), t.TempDir()
	root, closeRoot, err := openLifecycleRoot(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer closeRoot()
	kept := filepath.Join(outside, "private.txt")
	if err := os.WriteFile(kept, []byte("external-data"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"", ".1", ".2"} {
		t.Run("file"+suffix, func(t *testing.T) {
			link := filepath.Join(directory, "diagnostics", "lifecycle", "engine.jsonl"+suffix)
			if err := os.Link(kept, link); err != nil {
				t.Fatal(err)
			}
			newLifecycleLog(directory, "engine").record("launch", "process-start", lifecycleFields{})
			if content, err := os.ReadFile(kept); err != nil || string(content) != "external-data" {
				t.Fatal("lifecycle write followed a hardlink", err)
			}
			if err := root.Remove("engine.jsonl" + suffix); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestLifecycleSubprocess(t *testing.T) {
	switch os.Getenv("BRIDGE_LIFECYCLE_TEST_MODE") {
	case "network":
		os.Args = []string{"lifecycle-fixture", "--network-mode"}
		main()
		os.Exit(0)
	case "panic":
		func() {
			log := newLifecycleLog(os.Getenv("BRIDGE_LIFECYCLE_DIRECTORY"), "engine")
			code, reason := 0, "node-exited"
			defer finishLifecycleProcess(&log, &code, &reason)
			panic("fixture-secret-API-token")
		}()
		os.Exit(0)
	case "status":
		windows.ExitProcess(0xc0000005)
	}
}

func lifecycleSubprocess(t *testing.T, directory, mode, input string) (*os.ProcessState, error) {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=^TestLifecycleSubprocess$")
	command.Env = lifecycleEnvironment(os.Environ(), &lifecycleLog{session: "fixture-session"}, directory)
	command.Env = append(command.Env, "BRIDGE_LIFECYCLE_TEST_MODE="+mode)
	command.Stdin = strings.NewReader(input)
	hide(command)
	err := command.Run() // No raw child output is collected or persisted.
	return command.ProcessState, err
}

func TestLifecycleRealNetworkHelperEOFAndInvalidRPC(t *testing.T) {
	for _, fixture := range []struct {
		name, input, reason string
		code                uint32
	}{
		{"eof", "", "netcore-eof", 0},
		{"invalid-rpc", "{invalid-json\n", "netcore-run-failed", 1},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			directory := t.TempDir()
			state, err := lifecycleSubprocess(t, directory, "network", fixture.input)
			if state == nil || uint32(state.ExitCode()) != fixture.code || (err == nil) != (fixture.code == 0) {
				t.Fatalf("network exit does not preserve its result: %v %v", state, err)
			}
			rows := readLifecycleRows(t, directory, "network")
			last := rows[len(rows)-1]
			if rows[0].Event != "launch" || rows[0].SessionID != "fixture-session" ||
				last.Event != "end" || last.Reason != fixture.reason || last.ExitCode == nil || *last.ExitCode != fixture.code {
				t.Fatalf("network exit facts missing: %+v", rows)
			}
		})
	}
}

func TestLifecyclePanicIsNonzeroAndExcludesPanicValue(t *testing.T) {
	directory := t.TempDir()
	state, err := lifecycleSubprocess(t, directory, "panic", "")
	if err == nil || state.ExitCode() == 0 {
		t.Fatal("panic was swallowed as a successful exit")
	}
	rows := readLifecycleRows(t, directory, "engine")
	if len(rows) != 2 || rows[0].Event != "panic" || rows[0].PanicType != "string" ||
		rows[1].Event != "end" || rows[1].Reason != "unhandled-panic" || *rows[1].ExitCode == 0 {
		t.Fatalf("panic facts missing: %+v", rows)
	}
	data, _ := json.Marshal(rows)
	if bytes.Contains(data, []byte("fixture-secret")) || bytes.Contains(data, []byte("API-token")) {
		t.Fatal("panic contents reached disk")
	}
}

func TestLifecyclePreservesRealWindowsStatusAndNodeExit(t *testing.T) {
	directory := t.TempDir()
	log := newLifecycleLog(directory, "engine")
	state, err := lifecycleSubprocess(t, directory, "status", "")
	if code := log.observeChildExit(state, err, state.Pid()); code != 0xc0000005 {
		t.Fatalf("Windows exception status was truncated: %#x", code)
	}
	node, err := exec.LookPath("node.exe")
	if err != nil {
		t.Fatal("a real Node executable is required for launcher lifecycle verification")
	}
	for _, expected := range []uint32{0, 23} {
		command := exec.Command(node, "-e", fmt.Sprintf("process.exit(%d)", expected))
		hide(command)
		err := command.Run()
		if code := log.observeChildExit(command.ProcessState, err, command.Process.Pid); code != expected {
			t.Fatalf("Node exit status mismatch: %d != %d", code, expected)
		}
	}
	rows := readLifecycleRows(t, directory, "engine")
	if len(rows) != 3 || *rows[0].ExitCode != 0xc0000005 || *rows[1].ExitCode != 0 || *rows[2].ExitCode != 23 {
		t.Fatalf("real child status was not persisted: %+v", rows)
	}
}

func TestLifecycleUnavailableLoggingDoesNotChangeChildOrHelperResult(t *testing.T) {
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "diagnostics"), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	log := newLifecycleLog(directory, "engine")
	log.record("launch", "process-start", lifecycleFields{})
	if code := log.observeChildExit(nil, errors.New("fixture-secret"), 42); code != 1 {
		t.Fatal("unavailable logger changed failure status")
	}
	state, err := lifecycleSubprocess(t, directory, "network", "")
	if err != nil || state.ExitCode() != 0 {
		t.Fatal("unavailable logging prevented the helper from exiting successfully", err)
	}
	state, err = lifecycleSubprocess(t, directory, "network", "{invalid-json\n")
	if err == nil || state.ExitCode() != 1 {
		t.Fatal("unavailable logging changed the helper failure", err)
	}
	if content, err := os.ReadFile(filepath.Join(directory, "diagnostics")); err != nil || string(content) != "keep" {
		t.Fatal("unavailable logger overwrote its obstruction", err)
	}
}
