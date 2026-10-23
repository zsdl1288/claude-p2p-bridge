package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

const lifecycleMaximumBytes int64 = 512 * 1024

type lifecycleFields struct {
	ExitCode  *uint32 `json:"exitCode,omitempty"`
	ChildPID  int     `json:"childPid,omitempty"`
	Win32Code *uint32 `json:"win32Code,omitempty"`
	PanicType string  `json:"panicType,omitempty"`
}

type lifecycleRecord struct {
	V         int    `json:"v"`
	Version   string `json:"version"`
	UTC       string `json:"utc"`
	Component string `json:"component"`
	PID       int    `json:"pid"`
	SessionID string `json:"sessionId"`
	Event     string `json:"event"`
	Reason    string `json:"reason"`
	lifecycleFields
}

type lifecycleLog struct {
	directory, component, session string
	mu                            sync.Mutex
}

func lifecycleSession(value string) string {
	if len(value) > 0 && len(value) <= 96 && strings.IndexFunc(value, func(r rune) bool {
		return !(r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-')
	}) == -1 {
		return value
	}
	var id [16]byte
	_, _ = rand.Read(id[:])
	return hex.EncodeToString(id[:])
}

func newLifecycleLog(directory, component string) *lifecycleLog {
	return &lifecycleLog{directory: directory, component: component,
		session: lifecycleSession(os.Getenv("BRIDGE_LIFECYCLE_SESSION"))}
}

func lifecycleEnvironment(base []string, log *lifecycleLog, directory string) []string {
	result := make([]string, 0, len(base)+2)
	for _, entry := range base {
		key, _, _ := strings.Cut(entry, "=")
		if !strings.EqualFold(key, "BRIDGE_LIFECYCLE_SESSION") && !strings.EqualFold(key, "BRIDGE_LIFECYCLE_DIRECTORY") {
			result = append(result, entry)
		}
	}
	return append(result, "BRIDGE_LIFECYCLE_SESSION="+log.session, "BRIDGE_LIFECYCLE_DIRECTORY="+directory)
}

// The schema accepts only fixed lifecycle facts. Never pass argv, environment,
// RPC input, raw errors, panic values, stacks or application output to disk.
func (l *lifecycleLog) record(event, reason string, fields lifecycleFields) {
	if l == nil || (l.component != "engine" && l.component != "network") {
		return
	}
	switch event {
	case "launch", "startup-failed", "node-started", "node-exit", "child-kill", "panic", "end":
	default:
		return
	}
	switch reason {
	case "process-start", "startup-failed", "legacy-log-cleanup", "runtime-extract",
		"job-create", "job-configure", "node-start", "node-open", "node-assign",
		"child-started", "child-process-exit", "child-wait-failed", "owner-open-process-failed",
		"owner-job-assign-failed", "node-exited", "netcore-eof", "netcore-run-failed", "unhandled-panic":
	default:
		return
	}
	switch fields.PanicType {
	case "", "string", "runtime-error", "error", "other":
	default:
		fields.PanicType = "other"
	}
	row, err := json.Marshal(lifecycleRecord{V: 1, Version: version, UTC: time.Now().UTC().Format(time.RFC3339Nano),
		Component: l.component, PID: os.Getpid(), SessionID: l.session, Event: event, Reason: reason, lifecycleFields: fields})
	if err != nil || len(row)+1 > 4096 {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	// Network helper replacement can briefly overlap the previous helper.
	// Bound cross-process rotation/write coordination; logging never holds up
	// an application operation behind an unavailable writer.
	sum := sha256.Sum256([]byte(strings.ToLower(filepath.Clean(l.directory)) + "|" + l.component))
	name, err := windows.UTF16PtrFromString("Local\\ClaudeBridge.Lifecycle." + hex.EncodeToString(sum[:16]))
	if err != nil {
		return
	}
	mutex, err := windows.CreateMutex(nil, false, name)
	if err != nil {
		return
	}
	defer windows.CloseHandle(mutex)
	wait, err := windows.WaitForSingleObject(mutex, 25)
	if err != nil || (wait != windows.WAIT_OBJECT_0 && wait != windows.WAIT_ABANDONED) {
		return
	}
	defer windows.ReleaseMutex(mutex)
	root, closeRoot, err := openLifecycleRoot(l.directory)
	if err != nil {
		return
	}
	defer closeRoot()
	_ = appendLifecycleRecord(root, l.component+".jsonl", append(row, '\n'))
}

// Pin every existing ancestor without delete sharing. Check the directory
// handle itself before entering it, so a junction cannot redirect log writes.
func openLifecycleRoot(directory string) (*os.Root, func(), error) {
	var handles []windows.Handle
	var roots []*os.Root
	closeAll := func() {
		for i := len(roots) - 1; i >= 0; i-- {
			_ = roots[i].Close()
		}
		for i := len(handles) - 1; i >= 0; i-- {
			_ = windows.CloseHandle(handles[i])
		}
	}
	failed := true
	defer func() {
		if failed {
			closeAll()
		}
	}()
	if !filepath.IsAbs(directory) || filepath.Clean(directory) == filepath.VolumeName(directory)+string(filepath.Separator) {
		return nil, nil, errors.New("invalid lifecycle directory")
	}
	pin := func(path string) error {
		name, err := windows.UTF16PtrFromString(path)
		if err != nil {
			return err
		}
		handle, err := windows.CreateFile(name, windows.FILE_READ_ATTRIBUTES,
			windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING,
			windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
		if err != nil {
			return err
		}
		handles = append(handles, handle)
		var info windows.ByHandleFileInformation
		if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
			return err
		}
		if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 ||
			info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
			return errors.New("unsafe lifecycle directory")
		}
		return nil
	}
	var ancestors []string
	for path := filepath.Clean(directory); ; path = filepath.Dir(path) {
		ancestors = append(ancestors, path)
		if filepath.Dir(path) == path {
			break
		}
	}
	for i := len(ancestors) - 1; i >= 0; i-- {
		if err := pin(ancestors[i]); err != nil {
			return nil, nil, err
		}
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, nil, err
	}
	roots = append(roots, root)
	path := directory
	for _, child := range []string{"diagnostics", "lifecycle"} {
		if err := root.Mkdir(child, 0700); err != nil && !os.IsExist(err) {
			return nil, nil, err
		}
		path = filepath.Join(path, child)
		if err := pin(path); err != nil {
			return nil, nil, err
		}
		root, err = root.OpenRoot(child)
		if err != nil {
			return nil, nil, err
		}
		roots = append(roots, root)
	}
	failed = false
	return root, closeAll, nil
}

func checkedLifecycleFile(root *os.Root, name string, flags int) (*os.File, error) {
	before, err := root.Lstat(name)
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	if before != nil && (!before.Mode().IsRegular() || isReparsePoint(before)) {
		return nil, errors.New("unsafe lifecycle file")
	}
	file, err := root.OpenFile(name, flags, 0600)
	if err != nil {
		return nil, err
	}
	safe := false
	defer func() {
		if !safe {
			_ = file.Close()
		}
	}()
	opened, err := file.Stat()
	if err != nil {
		return nil, err
	}
	current, err := root.Lstat(name)
	if err != nil {
		return nil, err
	}
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(windows.Handle(file.Fd()), &info); err != nil {
		return nil, err
	}
	if !opened.Mode().IsRegular() || isReparsePoint(current) || !os.SameFile(opened, current) ||
		(before != nil && !os.SameFile(before, opened)) || info.NumberOfLinks > 1 ||
		info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return nil, errors.New("unsafe lifecycle file")
	}
	safe = true
	return file, nil
}

func appendLifecycleRecord(root *os.Root, name string, row []byte) error {
	// Inspect all rotation names before any mutation. Rename/remove operate on
	// the anchored entry itself, and never traverse its final component.
	for _, suffix := range []string{"", ".1", ".2"} {
		file, err := checkedLifecycleFile(root, name+suffix, os.O_RDONLY)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		_ = file.Close()
	}
	file, err := checkedLifecycleFile(root, name, os.O_APPEND|os.O_CREATE|os.O_WRONLY)
	if err != nil {
		return err
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return err
	}
	if info.Size()+int64(len(row)) > lifecycleMaximumBytes {
		_ = file.Close()
		if err := root.Remove(name + ".2"); err != nil && !os.IsNotExist(err) {
			return err
		}
		if err := root.Rename(name+".1", name+".2"); err != nil && !os.IsNotExist(err) {
			return err
		}
		if err := root.Rename(name, name+".1"); err != nil {
			return err
		}
		file, err = checkedLifecycleFile(root, name, os.O_APPEND|os.O_CREATE|os.O_WRONLY)
		if err != nil {
			return err
		}
	}
	defer file.Close()
	if _, err := file.Write(row); err != nil {
		return err
	}
	return file.Sync()
}

func (l *lifecycleLog) startupFailure(stage string, err error) {
	var code syscall.Errno
	var fields lifecycleFields
	if errors.As(err, &code) {
		value := uint32(code)
		fields.Win32Code = &value
	}
	l.record("startup-failed", stage, fields)
}

func (l *lifecycleLog) observeChildExit(state *os.ProcessState, err error, childPID int) uint32 {
	code := uint32(1)
	reason := "child-wait-failed"
	if state != nil && state.ExitCode() != -1 {
		code = uint32(state.ExitCode())
		reason = "child-process-exit"
	} else if err == nil {
		code = 0
	}
	l.record("node-exit", reason, lifecycleFields{ExitCode: &code, ChildPID: childPID})
	return code
}

// Deferred directly by main so recover observes only a panic in main's own
// goroutine. No panic text is persisted or treated as a successful exit.
func finishLifecycleProcess(log **lifecycleLog, exitCode *int, endReason *string) {
	if value := recover(); value != nil {
		*exitCode = 1
		*endReason = "unhandled-panic"
		kind := "other"
		switch value.(type) {
		case string:
			kind = "string"
		case runtime.Error:
			kind = "runtime-error"
		case error:
			kind = "error"
		}
		(*log).record("panic", "unhandled-panic", lifecycleFields{PanicType: kind})
	}
	code := uint32(*exitCode)
	(*log).record("end", *endReason, lifecycleFields{ExitCode: &code})
	if *exitCode != 0 {
		os.Exit(*exitCode)
	}
}
