//go:build windows

package netcore

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"tailscale.com/ipn/store"
	"tailscale.com/paths"
)

func stateDirTestUser(t *testing.T) *windows.SID {
	t.Helper()
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	return user.User.Sid
}

func stateDirTestSecurity(t *testing.T, path string) *windows.SECURITY_DESCRIPTOR {
	t.Helper()
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	return sd
}

func assertPrivateStateDirACL(t *testing.T, path string, user *windows.SID) {
	t.Helper()
	sd := stateDirTestSecurity(t, path)
	control, _, err := sd.Control()
	if err != nil || control&windows.SE_DACL_PROTECTED == 0 {
		t.Fatal("state directory still inherits its parent permissions", err)
	}
	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil || dacl.AceCount != 2 {
		t.Fatalf("expected only current user and Administrators: %s (%v)", sd, err)
	}
	seenUser, seenAdmin := false, false
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			t.Fatal(err)
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE || ace.Mask&windows.STANDARD_RIGHTS_ALL != windows.STANDARD_RIGHTS_ALL ||
			ace.Header.AceFlags != windows.OBJECT_INHERIT_ACE|windows.CONTAINER_INHERIT_ACE {
			t.Fatalf("state directory must grant inheritable Full Control: %s", sd)
		}
		switch {
		case sid.Equals(user):
			seenUser = true
		case sid.IsWellKnown(windows.WinBuiltinAdministratorsSid):
			seenAdmin = true
		default:
			t.Fatalf("unexpected state directory access for %s", sid)
		}
	}
	if !seenUser || !seenAdmin {
		t.Fatalf("missing private state directory trustees: %s", sd)
	}
}

func TestPrepareStateDirRepairsModifyForTailscale(t *testing.T) {
	t.Logf("Windows token elevated: %v", windows.GetCurrentProcessToken().IsElevated())
	parent := t.TempDir()
	directory := filepath.Join(parent, "tailscale")
	if err := os.Mkdir(directory, 0700); err != nil {
		t.Fatal(err)
	}
	saved := filepath.Join(directory, "tailscaled.state")
	const savedState = `{"fixture":"c2F2ZWQgbmV0d29yayBpZGVudGl0eQ=="}`
	if err := os.WriteFile(saved, []byte(savedState), 0600); err != nil {
		t.Fatal(err)
	}
	user := stateDirTestUser(t)
	// Reproduce a portable installation inheriting Modify instead of Full
	// Control. Do not grant Administrators here, so elevation cannot mask it.
	modify, err := windows.SecurityDescriptorFromString("D:P(A;OICI;0x1301bf;;;" + user.String() + ")")
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := modify.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(directory, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		user, nil, dacl, nil); err != nil {
		t.Fatal(err)
	}
	parentBefore := stateDirTestSecurity(t, parent).String()
	// The actual upstream state store sets the owner, primary group and DACL
	// before reading state. This local initialization starts no network.
	logf := func(string, ...any) {}
	if _, err := store.NewFileStore(logf, saved); !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		t.Fatalf("Modify-only fixture did not reproduce Tailscale Access Denied: %v", err)
	}
	m, err := New(Config{StateDir: directory, Hostname: "permissions-test"})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	assertPrivateStateDirACL(t, directory, user)
	first := stateDirTestSecurity(t, directory).String()
	if err := prepareStateDir(directory); err != nil {
		t.Fatal(err)
	}
	if got := stateDirTestSecurity(t, directory).String(); got != first {
		t.Fatal("repeated preparation changed the private directory permissions")
	}
	state, err := store.NewFileStore(logf, saved)
	if err != nil {
		t.Fatalf("Tailscale still cannot set its owner, group and DACL: %v", err)
	}
	if got, err := state.ReadState("fixture"); err != nil || string(got) != "saved network identity" {
		t.Fatal("Tailscale could not read the saved network identity", err)
	}
	if got, err := os.ReadFile(saved); err != nil || string(got) != savedState {
		t.Fatal("state preparation changed the saved network identity", err)
	}
	if got := stateDirTestSecurity(t, parent).String(); got != parentBefore {
		t.Fatal("state preparation changed parent directory security")
	}
}

func TestPrepareStateDirCreatesNestedDirectory(t *testing.T) {
	parent := t.TempDir()
	before := stateDirTestSecurity(t, parent).String()
	directory := filepath.Join(parent, "new-data", "tailscale")
	if err := prepareStateDir(directory); err != nil {
		t.Fatal(err)
	}
	assertPrivateStateDirACL(t, directory, stateDirTestUser(t))
	if err := paths.MkStateDir(directory); err != nil {
		t.Fatal(err)
	}
	if stateDirTestSecurity(t, parent).String() != before {
		t.Fatal("creating state changed an existing ancestor's permissions")
	}
}

func stateDirTestJunction(t *testing.T, link, target string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "pwsh", "-NoProfile", "-NonInteractive", "-Command",
		"$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:BRIDGE_TEST_STATE_LINK -Target $env:BRIDGE_TEST_STATE_TARGET | Out-Null")
	command.Env = append(os.Environ(), "BRIDGE_TEST_STATE_LINK="+link, "BRIDGE_TEST_STATE_TARGET="+target)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("create isolated state directory junction: %v: %s", err, output)
	}
}

func TestPrepareStateDirRejectsReparsePoints(t *testing.T) {
	for _, nested := range []bool{false, true} {
		t.Run(map[bool]string{false: "leaf", true: "ancestor"}[nested], func(t *testing.T) {
			parent := t.TempDir()
			target := filepath.Join(parent, "target")
			if err := os.Mkdir(target, 0700); err != nil {
				t.Fatal(err)
			}
			before := stateDirTestSecurity(t, target).String()
			link := filepath.Join(parent, "link")
			// Junctions reproduce both reparse boundaries without elevation or
			// Developer Mode, so this protection is exercised on normal Windows.
			stateDirTestJunction(t, link, target)
			directory := link
			if nested {
				directory = filepath.Join(link, "tailscale")
			}
			if err := prepareStateDir(directory); err == nil || !strings.Contains(err.Error(), "reparse point") {
				t.Fatalf("expected a clear reparse-point refusal: %v", err)
			}
			if stateDirTestSecurity(t, target).String() != before {
				t.Fatal("state preparation changed the linked target")
			}
			if nested {
				if _, err := os.Stat(filepath.Join(target, "tailscale")); !os.IsNotExist(err) {
					t.Fatal("state preparation created data through a reparse point", err)
				}
			}
		})
	}
}

func TestPrepareStateDirAllowsEnabledAdministratorOwner(t *testing.T) {
	admin, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		t.Fatal(err)
	}
	member, err := windows.Token(0).IsMember(admin)
	if err != nil {
		t.Fatal(err)
	}
	if !member {
		t.Skip("Administrators-owned creation compatibility requires an enabled administrator token")
	}
	directory := t.TempDir()
	user := stateDirTestUser(t)
	modify, err := windows.SecurityDescriptorFromString("D:P(A;OICI;0x1301bf;;;" + user.String() + ")")
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := modify.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(directory, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		admin, nil, dacl, nil); err != nil {
		t.Fatal(err)
	}
	if err := prepareStateDir(directory); err != nil {
		t.Fatal(err)
	}
	assertPrivateStateDirACL(t, directory, user)
	owner, _, err := stateDirTestSecurity(t, directory).Owner()
	if err != nil || owner == nil || !owner.Equals(user) {
		t.Fatalf("Administrators-owned directory must become user-owned before tsnet starts: owner=%v, error=%v", owner, err)
	}
	first := stateDirTestSecurity(t, directory).String()
	if err := prepareStateDir(directory); err != nil {
		t.Fatal(err)
	}
	if got := stateDirTestSecurity(t, directory).String(); got != first {
		t.Fatal("repeated preparation changed the normalized owner or private permissions")
	}
	if err := paths.MkStateDir(directory); err != nil {
		t.Fatalf("Tailscale cannot secure an elevated-created state directory: %v", err)
	}
}

func TestStateDirOwnerBoundary(t *testing.T) {
	user := stateDirTestUser(t)
	foreign, err := windows.CreateWellKnownSid(windows.WinLocalServiceSid)
	if err != nil {
		t.Fatal(err)
	}
	if allowed, err := stateDirOwnerAllowed(foreign, user); err != nil || allowed {
		t.Fatal("must not repair a different account's state directory", err)
	}
	if allowed, err := stateDirOwnerAllowed(nil, user); err != nil || allowed {
		t.Fatal("must not repair a directory without a verified owner", err)
	}
	admin, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		t.Fatal(err)
	}
	member, err := windows.Token(0).IsMember(admin)
	if err != nil {
		t.Fatal(err)
	}
	if allowed, err := stateDirOwnerAllowed(admin, user); err != nil || allowed != member {
		t.Fatal("Administrators ownership must require enabled token membership", err)
	}
}
