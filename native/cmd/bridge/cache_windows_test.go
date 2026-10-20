package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func writeCacheTestFile(t *testing.T, directory, name string) string {
	t.Helper()
	path := filepath.Join(directory, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(name), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestGeneratedCacheCleanupKeepsProfilesAndCurrentStartupAndLiveCaches(t *testing.T) {
	directory := t.TempDir()
	kept := []string{
		"pairing.dat", "desktop.ini", "application.json", "proxy.json", "api-token", "tailscale/tailscale.state",
		"app/1.1.5-11111111111111111111/ClaudeBridge.exe",
		"app/1.1.4-22222222222222222222/ClaudeBridge.exe",
		"engine/1.1.5/33333333333333333333/bridge-engine.exe",
		"runtime/4444444444444444/runtime/node.exe",
		"runtime/5555555555555555/runtime/node.exe",
		"app/1.1.6-66666666666666666666/ClaudeBridge.exe",
		"engine/1.2.0/77777777777777777777/bridge-engine.exe",
		"app/custom/notes.txt", "runtime/manual/notes.txt", "engine/1.1.3/notes.txt", "engine/1.1.6/bridge-engine.exe",
	}
	for _, name := range kept {
		writeCacheTestFile(t, directory, name)
	}
	deleted := []string{
		"app/1.1.3-aaaaaaaaaaaaaaaaaaaa/ClaudeBridge.exe",
		"engine/1.1.4/bbbbbbbbbbbbbbbbbbbb/bridge-engine.exe",
		"runtime/cccccccccccccccc/src/main.js",
		"engine/1.1.3/bridge-engine.exe",
	}
	for _, name := range deleted {
		writeCacheTestFile(t, directory, name)
	}
	// The actual collector combines current self, runtime, startup and process
	// image paths; inject those inputs rather than reading real user state.
	state := generatedCacheState{version: "1.1.5", preserve: []string{
		filepath.Join(directory, filepath.FromSlash(kept[6])),
		strings.ToUpper(filepath.Join(directory, filepath.FromSlash(kept[7]))),
		filepath.Join(directory, filepath.FromSlash(kept[8])),
		filepath.Dir(filepath.Dir(filepath.Join(directory, filepath.FromSlash(kept[9])))),
		`\\?\` + filepath.Join(directory, filepath.FromSlash(kept[10])),
	}}
	removed, err := pruneGeneratedCaches(directory, state)
	if err != nil || len(removed) != len(deleted) {
		t.Fatalf("removed %v: %v", removed, err)
	}
	for _, name := range kept {
		content, err := os.ReadFile(filepath.Join(directory, filepath.FromSlash(name)))
		if err != nil || string(content) != name {
			t.Errorf("preserved file changed: %s: %v", name, err)
		}
	}
	for _, name := range deleted {
		if _, err := os.Stat(filepath.Join(directory, filepath.FromSlash(name))); !os.IsNotExist(err) {
			t.Errorf("old cache remains: %s: %v", name, err)
		}
	}
	if removed, err := pruneGeneratedCaches(directory, state); err != nil || len(removed) != 0 {
		t.Fatalf("cleanup is not idempotent: %v: %v", removed, err)
	}
}

func TestGeneratedCacheCleanupSkipsUnknownNamesAndUnresolvedOrLockedExecutables(t *testing.T) {
	directory := t.TempDir()
	kept := []string{
		"runtime/1111111111111111/runtime/node.exe",
		"app/1.1.3-22222222222222222222/ClaudeBridge.exe",
		"runtime/too-short/file.txt", "runtime/AAAAAAAAAAAAAAAA/file.txt",
		"app/1.1.3-333333333333333333333/file.txt", "engine/1.1/44444444444444444444/file.txt",
		"app/18446744073709551616.0.0-55555555555555555555/file.txt",
		"engine/1.1.5/bridge-engine.exe",
	}
	for _, name := range kept {
		writeCacheTestFile(t, directory, name)
	}
	locked, err := os.OpenFile(filepath.Join(directory, filepath.FromSlash(kept[1])), os.O_RDONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer locked.Close()
	legacyLocked, err := os.OpenFile(filepath.Join(directory, filepath.FromSlash(kept[len(kept)-1])), os.O_RDONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer legacyLocked.Close()
	state := generatedCacheState{version: "1.1.5", unresolvedProcesses: []string{"NODE.EXE"}}
	if _, err := pruneGeneratedCaches(directory, state); err != nil {
		t.Fatal(err)
	}
	for _, name := range kept {
		if _, err := os.Stat(filepath.Join(directory, filepath.FromSlash(name))); err != nil {
			t.Errorf("unsafe candidate removed: %s: %v", name, err)
		}
	}
	// A file with a generated directory name is still user data.
	file := writeCacheTestFile(t, directory, "runtime/6666666666666666")
	if _, err := pruneGeneratedCaches(directory, state); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(file); err != nil {
		t.Fatal("similarly named file was removed", err)
	}
}

func TestGeneratedCacheCleanupDoesNotFollowJunctions(t *testing.T) {
	for _, kind := range []string{"profile", "ancestor", "group", "candidate", "nested"} {
		t.Run(kind, func(t *testing.T) {
			directory, outside := t.TempDir(), t.TempDir()
			external := writeCacheTestFile(t, outside, "runtime/1111111111111111/keep.txt")
			switch kind {
			case "profile":
				link := filepath.Join(directory, "linked")
				runtimeJunction(t, link, outside)
				directory = link
			case "ancestor":
				link := filepath.Join(directory, "linked")
				runtimeJunction(t, link, outside)
				directory = filepath.Join(link, "runtime")
			case "group":
				runtimeJunction(t, filepath.Join(directory, "runtime"), filepath.Join(outside, "runtime"))
			case "candidate":
				if err := os.Mkdir(filepath.Join(directory, "runtime"), 0700); err != nil {
					t.Fatal(err)
				}
				runtimeJunction(t, filepath.Join(directory, "runtime", "1111111111111111"), filepath.Dir(external))
			case "nested":
				parent := filepath.Join(directory, "runtime", "1111111111111111")
				writeCacheTestFile(t, parent, "ordinary.txt")
				runtimeJunction(t, filepath.Join(parent, "linked"), outside)
			}
			if _, err := pruneGeneratedCaches(directory, generatedCacheState{version: "1.1.5"}); err != nil {
				t.Fatal(err)
			}
			if content, err := os.ReadFile(external); err != nil || string(content) != "runtime/1111111111111111/keep.txt" {
				t.Fatal("cleanup reached a junction target", err)
			}
			if kind == "nested" {
				if _, err := os.Stat(filepath.Join(directory, "runtime", "1111111111111111", "ordinary.txt")); err != nil {
					t.Fatal("candidate was partially removed before junction preflight", err)
				}
			}
		})
	}
}

func TestGeneratedCacheCleanupPreservesShortPathAliases(t *testing.T) {
	directory := t.TempDir()
	image := writeCacheTestFile(t, directory, "app/1.1.5-11111111111111111111/ClaudeBridge.exe")
	pointer, err := windows.UTF16PtrFromString(image)
	if err != nil {
		t.Fatal(err)
	}
	buffer := make([]uint16, 32768)
	size, err := windows.GetShortPathName(pointer, &buffer[0], uint32(len(buffer)))
	if err != nil || size >= uint32(len(buffer)) {
		t.Skip("short names unavailable", err)
	}
	short := windows.UTF16ToString(buffer[:size])
	if strings.EqualFold(short, image) {
		t.Skip("volume does not provide 8.3 aliases")
	}
	if removed, err := pruneGeneratedCaches(directory, generatedCacheState{version: "1.1.5", preserve: []string{short}}); err != nil || len(removed) != 0 {
		t.Fatalf("short startup/process path not preserved: %v: %v", removed, err)
	}
	if content, err := os.ReadFile(image); err != nil || string(content) != "app/1.1.5-11111111111111111111/ClaudeBridge.exe" {
		t.Fatal("aliased cache changed", err)
	}
}

func TestGeneratedCacheCleanupProcessInventoryFindsCurrentImage(t *testing.T) {
	images, _, err := cacheProcessImages()
	if err != nil {
		t.Fatal(err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, image := range images {
		if normalizedCachePath(image) == normalizedCachePath(self) {
			return
		}
	}
	t.Fatal("current process executable missing from preservation inventory")
}
