package main

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

var cacheVersionPattern = regexp.MustCompile(`^(\d+)\.(\d+)\.(\d+)$`)
var appCachePattern = regexp.MustCompile(`^(\d+\.\d+\.\d+)-[0-9a-f]{20}$`)
var engineCachePattern = regexp.MustCompile(`^[0-9a-f]{20}$`)
var runtimeCachePattern = regexp.MustCompile(`^[0-9a-f]{16}$`)

type generatedCacheState struct {
	version             string
	preserve            []string
	unresolvedProcesses []string
}

// Called only after the owned engine becomes ready. Cleanup is optional: an
// unreadable registry/process inventory, a link or a locked file is retried on
// a later launch, never treated as a startup failure.
func cleanupGeneratedCaches(directory, runtimeDirectory string) {
	self, err := os.Executable()
	if err != nil {
		return
	}
	startup, err := cacheStartupExecutable()
	if err != nil {
		return
	}
	images, unresolved, err := cacheProcessImages()
	if err != nil {
		return
	}
	// A standalone engine may still be extracting its runtime before Node is
	// visible. Normal desktop starts are serialized by the profile owner.
	for _, image := range images {
		if cachePathContains(directory, image) && strings.EqualFold(filepath.Base(image), "bridge-engine.exe") && normalizedCachePath(image) != normalizedCachePath(self) {
			return
		}
	}
	for _, name := range unresolved {
		if strings.EqualFold(name, "bridge-engine.exe") {
			return
		}
	}
	images = append(images, self, runtimeDirectory)
	if startup != "" {
		images = append(images, startup)
	}
	_, _ = pruneGeneratedCaches(directory, generatedCacheState{version, images, unresolved})
}

func cacheStartupExecutable() (string, error) {
	key, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Run`, registry.QUERY_VALUE)
	if errors.Is(err, registry.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	defer key.Close()
	command, kind, err := key.GetStringValue("ClaudeBridge")
	if errors.Is(err, registry.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if kind == registry.EXPAND_SZ {
		command, err = registry.ExpandString(command)
		if err != nil {
			return "", err
		}
	}
	arguments, err := windows.DecomposeCommandLine(command)
	if err != nil || len(arguments) == 0 || !filepath.IsAbs(arguments[0]) {
		return "", errors.New("unrecognized startup executable")
	}
	return arguments[0], nil
}

func cacheProcessImages() (paths, unresolved []string, err error) {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, nil, err
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	err = windows.Process32First(snapshot, &entry)
	for err == nil {
		if entry.ProcessID != 0 {
			name := windows.UTF16ToString(entry.ExeFile[:])
			process, openError := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, entry.ProcessID)
			buffer, size := make([]uint16, 32768), uint32(32768)
			if openError == nil {
				openError = windows.QueryFullProcessImageName(process, 0, &buffer[0], &size)
				windows.CloseHandle(process)
			}
			if openError == nil {
				paths = append(paths, windows.UTF16ToString(buffer[:size]))
			} else if name != "" {
				// Protected system processes cannot always be queried. Keep every
				// cache containing the same executable name rather than guessing.
				unresolved = append(unresolved, strings.ToLower(name))
			} else {
				return nil, nil, openError
			}
		}
		err = windows.Process32Next(snapshot, &entry)
	}
	if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
		err = nil
	}
	return
}

func cacheVersion(value string) ([3]uint64, bool) {
	var result [3]uint64
	parts := cacheVersionPattern.FindStringSubmatch(value)
	if parts == nil {
		return result, false
	}
	for index := range result {
		var err error
		result[index], err = strconv.ParseUint(parts[index+1], 10, 64)
		if err != nil {
			return result, false
		}
	}
	return result, true
}

func cacheVersionNotNewer(value string, current [3]uint64) bool {
	parsed, ok := cacheVersion(value)
	if !ok {
		return false
	}
	for index := range parsed {
		if parsed[index] != current[index] {
			return parsed[index] < current[index]
		}
	}
	return true
}

func plainCacheAncestry(directory string) bool {
	for current := directory; ; current = filepath.Dir(current) {
		info, err := os.Lstat(current)
		if err != nil || !info.IsDir() || isReparsePoint(info) {
			return false
		}
		if filepath.Dir(current) == current {
			return true
		}
	}
}

func cacheDirectoryEntries(root *os.Root, name string) ([]os.DirEntry, error) {
	info, err := root.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || isReparsePoint(info) {
		return nil, errors.New("cache directory is not an ordinary directory")
	}
	file, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return file.ReadDir(-1)
}

func normalizedCachePath(value string) string {
	value = filepath.Clean(value)
	if strings.HasPrefix(value, `\\?\UNC\`) {
		value = `\\` + value[len(`\\?\UNC\`):]
	} else {
		value = strings.TrimPrefix(value, `\\?\`)
	}
	// Process and Run paths can use an 8.3 alias even when --data-dir uses
	// long names (or vice versa). Compare their existing long names.
	if pointer, err := windows.UTF16PtrFromString(value); err == nil {
		buffer := make([]uint16, 32768)
		if size, err := windows.GetLongPathName(pointer, &buffer[0], uint32(len(buffer))); err == nil && size < uint32(len(buffer)) {
			value = windows.UTF16ToString(buffer[:size])
		}
	}
	return strings.ToLower(value)
}

func cachePathContains(directory, path string) bool {
	directory, path = normalizedCachePath(directory), normalizedCachePath(path)
	return path == directory || strings.HasPrefix(path, directory+string(filepath.Separator))
}

// Preflight the complete candidate before removing any files. Rooted removal
// also prevents a concurrent junction change from escaping the profile.
func cacheTreeRemovable(root *os.Root, name string, unresolved map[string]bool) bool {
	info, err := root.Lstat(name)
	if err != nil || isReparsePoint(info) {
		return false
	}
	if info.Mode().IsRegular() {
		return !unresolved[strings.ToLower(filepath.Base(name))]
	}
	if !info.IsDir() {
		return false
	}
	entries, err := cacheDirectoryEntries(root, name)
	if err != nil {
		return false
	}
	for _, entry := range entries {
		if !cacheTreeRemovable(root, filepath.Join(name, entry.Name()), unresolved) {
			return false
		}
	}
	return true
}

func pruneGeneratedCaches(directory string, state generatedCacheState) ([]string, error) {
	current, ok := cacheVersion(state.version)
	if !ok {
		return nil, nil
	}
	directory, err := filepath.Abs(directory)
	if err != nil || !plainCacheAncestry(directory) {
		return nil, err
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	var candidates []string
	for _, group := range []string{"app", "engine", "runtime"} {
		entries, err := cacheDirectoryEntries(root, group)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			name, relative := entry.Name(), filepath.Join(group, entry.Name())
			switch group {
			case "app":
				parts := appCachePattern.FindStringSubmatch(name)
				if parts != nil && cacheVersionNotNewer(parts[1], current) {
					candidates = append(candidates, relative)
				}
			case "runtime":
				if runtimeCachePattern.MatchString(name) {
					candidates = append(candidates, relative)
				}
			case "engine":
				if !cacheVersionNotNewer(name, current) {
					continue
				}
				leaves, err := cacheDirectoryEntries(root, relative)
				if err != nil {
					continue
				}
				for _, leaf := range leaves {
					if engineCachePattern.MatchString(leaf.Name()) || leaf.Name() == "bridge-engine.exe" {
						candidates = append(candidates, filepath.Join(relative, leaf.Name()))
					}
				}
			}
		}
	}
	unknown := make(map[string]bool)
	for _, name := range state.unresolvedProcesses {
		unknown[strings.ToLower(name)] = true
	}
	var removed []string
	for _, candidate := range candidates {
		protected := false
		for _, path := range state.preserve {
			if cachePathContains(filepath.Join(directory, candidate), path) {
				protected = true
				break
			}
		}
		if protected || !cacheTreeRemovable(root, candidate, unknown) {
			continue
		}
		// Legacy launchers used engine/<version>/bridge-engine.exe. Remove
		// that exact ordinary file, leaving any other legacy files untouched.
		legacyEngine := strings.HasPrefix(candidate, "engine"+string(filepath.Separator)) && filepath.Base(candidate) == "bridge-engine.exe"
		info, err := root.Lstat(candidate)
		if err != nil || isReparsePoint(info) || (legacyEngine && !info.Mode().IsRegular()) || (!legacyEngine && !info.IsDir()) {
			continue
		}
		if legacyEngine {
			err = root.Remove(candidate)
		} else {
			err = root.RemoveAll(candidate)
		}
		if err == nil {
			removed = append(removed, candidate)
			if strings.HasPrefix(candidate, "engine"+string(filepath.Separator)) {
				_ = root.Remove(filepath.Dir(candidate)) // Empty version parents only.
			}
		}
	}
	return removed, nil
}
