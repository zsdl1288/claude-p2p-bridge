package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
	"time"
)

func runtimeArchive(t *testing.T, name, content string) []byte {
	t.Helper()
	var data bytes.Buffer
	archive := zip.NewWriter(&data)
	file, err := archive.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte(content)); err != nil {
		t.Fatal(err)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}

func runtimeJunction(t *testing.T, link, target string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	// Junctions do not require Developer Mode or symlink privileges. Paths are
	// t.TempDir descendants, passed as environment values rather than code.
	command := exec.CommandContext(ctx, filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
		"-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:BRIDGE_TEST_JUNCTION_LINK -Target $env:BRIDGE_TEST_JUNCTION_TARGET | Out-Null")
	command.Env = append(os.Environ(), "BRIDGE_TEST_JUNCTION_LINK="+link, "BRIDGE_TEST_JUNCTION_TARGET="+target)
	hide(command)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("create isolated runtime junction: %v: %s", err, output)
	}
	info, err := os.Lstat(link)
	if err != nil {
		t.Fatal(err)
	}
	attributes, ok := info.Sys().(*syscall.Win32FileAttributeData)
	if !ok || attributes.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT == 0 {
		t.Fatal("runtime junction is not a Windows reparse point")
	}
	// Since Go 1.23, Junctions are ModeIrregular rather than ModeSymlink, so
	// EvalSymlinks deliberately leaves them alone. Stat follows the reparse
	// point and SameFile verifies its actual destination without that assumption.
	actual, err := os.Stat(link)
	if err != nil {
		t.Fatal(err)
	}
	expected, err := os.Stat(target)
	if err != nil || !os.SameFile(actual, expected) {
		t.Fatalf("runtime junction does not resolve to its isolated target: %v", err)
	}
}

func TestRuntimeExtractionRepairsCorruptionAndSupportsConcurrentStarts(t *testing.T) {
	directory := t.TempDir()
	bundled := runtimeArchive(t, "src/main.js", "original runtime")
	root, err := extractPayload(directory, bundled)
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "src", "main.js")
	if err := os.WriteFile(target, []byte("incomplete interrupted write"), 0600); err != nil {
		t.Fatal(err)
	}
	var group sync.WaitGroup
	for range 8 {
		group.Go(func() {
			if actual, err := extractPayload(directory, bundled); err != nil || actual != root {
				t.Errorf("concurrent extraction failed: %v / %v", actual, err)
			}
		})
	}
	group.Wait()
	content, err := os.ReadFile(target)
	if err != nil || string(content) != "original runtime" {
		t.Fatal("runtime was not repaired", err)
	}
	entries, err := os.ReadDir(filepath.Dir(target))
	if err != nil || len(entries) != 1 {
		t.Fatal("temporary extraction files were not cleaned", entries, err)
	}
}

func TestRuntimeExtractionRejectsEscapingAndWindowsDevicePaths(t *testing.T) {
	for _, name := range []string{"../outside", "nested/../../outside", "/absolute", "C:/absolute", "CON", "nested/NUL", "main.js:stream"} {
		t.Run(name, func(t *testing.T) {
			if _, err := extractPayload(t.TempDir(), runtimeArchive(t, name, "invalid")); err == nil {
				t.Fatal("unsafe archive path was accepted")
			}
		})
	}
}

func TestRuntimeExtractionDoesNotFollowAnExternalJunction(t *testing.T) {
	directory := t.TempDir()
	bundled := runtimeArchive(t, "nested/main.js", "runtime")
	root, err := extractPayload(directory, bundled)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(root, "nested")); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	runtimeJunction(t, filepath.Join(root, "nested"), outside)
	if _, err := extractPayload(directory, bundled); err == nil {
		t.Fatal("extraction followed a junction outside its runtime root")
	}
	if _, err := os.Stat(filepath.Join(outside, "main.js")); !os.IsNotExist(err) {
		t.Fatal("extraction wrote outside its runtime", err)
	}
}

func TestRuntimeExtractionDoesNotFollowAnExternalRuntimeRoot(t *testing.T) {
	bundled := runtimeArchive(t, "src/main.js", "runtime")
	sum := sha256.Sum256(bundled)
	for _, relative := range []string{"runtime", filepath.Join("runtime", hex.EncodeToString(sum[:8]))} {
		t.Run(relative, func(t *testing.T) {
			directory, outside := t.TempDir(), t.TempDir()
			link := filepath.Join(directory, relative)
			if err := os.MkdirAll(filepath.Dir(link), 0700); err != nil {
				t.Fatal(err)
			}
			runtimeJunction(t, link, outside)
			if _, err := extractPayload(directory, bundled); err == nil {
				t.Fatal("extraction followed a runtime root junction outside its data directory")
			}
			entries, err := os.ReadDir(outside)
			if err != nil || len(entries) != 0 {
				t.Fatal("extraction modified the external runtime directory", entries, err)
			}
		})
	}
}
