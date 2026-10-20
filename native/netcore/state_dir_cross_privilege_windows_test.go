//go:build windows

package netcore

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
	"tailscale.com/ipn/store"
)

var stateDirRestartPhase = flag.String("bridge-state-restart-phase", "", "isolated cross-token state test phase")
var stateDirRestartFixture = flag.String("bridge-state-restart-fixture", "", "absolute isolated cross-token state test directory")

const restartFixtureKind = "claude-bridge-cross-token-state-test-v1"
const restartSavedState = `{"fixture":"c2F2ZWQgbmV0d29yayBpZGVudGl0eQ=="}`

type stateRestartFixture struct {
	Kind       string `json:"kind"`
	UserSID    string `json:"userSid"`
	ParentSDDL string `json:"parentSddl"`
}

type stateRestartReceipt struct {
	Phase           string `json:"phase"`
	Passed          bool   `json:"passed"`
	Elevated        bool   `json:"elevated"`
	EnabledAdmin    bool   `json:"enabledAdmin"`
	IntegritySID    string `json:"integritySid"`
	UserSID         string `json:"userSid"`
	InitialOwner    string `json:"initialOwner,omitempty"`
	FinalOwner      string `json:"finalOwner,omitempty"`
	SavedSHA256     string `json:"savedSha256,omitempty"`
	ControlRejected bool   `json:"unnormalizedControlRejected,omitempty"`
	Stage           string `json:"stage"`
}

func stateRestartWriteJSON(t *testing.T, path string, value any) {
	t.Helper()
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(data, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
}

func stateRestartReadJSON(t *testing.T, path string, value any) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, value); err != nil {
		t.Fatal(err)
	}
}

func stateRestartOwner(t *testing.T, path string) string {
	t.Helper()
	owner, _, err := stateDirTestSecurity(t, path).Owner()
	if err != nil || owner == nil {
		t.Fatal("cannot inspect isolated state directory owner", err)
	}
	return owner.String()
}

// Run only through scripts/test-windows-state-restart.py. The runner requires
// real high and medium integrity processes; ordinary unit runs cannot replace
// that acceptance check with a simulated token or a successful skip.
func TestStateDirCrossPrivilegeRestart(t *testing.T) {
	phase, fixture := *stateDirRestartPhase, *stateDirRestartFixture
	if phase == "" {
		t.Skip("run scripts/test-windows-state-restart.py for the required high-to-normal restart acceptance test")
	}
	if phase != "baseline" && phase != "elevated" && phase != "restart" {
		t.Fatalf("unknown cross-token test phase %q", phase)
	}
	if !filepath.IsAbs(fixture) {
		t.Fatal("an absolute isolated fixture directory is required")
	}
	user := stateDirTestUser(t)
	admin, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		t.Fatal(err)
	}
	member, err := windows.Token(0).IsMember(admin)
	if err != nil {
		t.Fatal(err)
	}
	// TOKEN_MANDATORY_LABEL contains a SID pointer. Use word-aligned backing
	// storage; a byte array may be placed at an unaligned stack address, which
	// makes Windows reject GetTokenInformation with ERROR_NOACCESS.
	var tokenData [128]uintptr
	var tokenSize uint32
	if err := windows.GetTokenInformation(windows.GetCurrentProcessToken(), windows.TokenIntegrityLevel,
		(*byte)(unsafe.Pointer(&tokenData[0])), uint32(unsafe.Sizeof(tokenData)), &tokenSize); err != nil {
		t.Fatal(err)
	}
	label := (*windows.SIDAndAttributes)(unsafe.Pointer(&tokenData[0]))
	receipt := stateRestartReceipt{Phase: phase, UserSID: user.String(), Elevated: windows.GetCurrentProcessToken().IsElevated(),
		EnabledAdmin: member, IntegritySID: label.Sid.String(), Stage: "verify process token"}
	t.Cleanup(func() {
		receipt.Passed = !t.Failed()
		stateRestartWriteJSON(t, filepath.Join(fixture, phase+".json"), receipt)
	})
	if phase == "elevated" {
		if !receipt.Elevated || !member || receipt.IntegritySID != "S-1-16-12288" {
			t.Fatalf("elevated phase requires an actual high-integrity administrator token: %+v", receipt)
		}
	} else if receipt.Elevated || member || receipt.IntegritySID != "S-1-16-8192" {
		t.Fatalf("baseline and restart require an ordinary medium-integrity token: %+v", receipt)
	}
	parent := filepath.Join(fixture, "profile")
	directory := filepath.Join(parent, "tailscale")
	control := filepath.Join(parent, "unnormalized-control")
	saved := filepath.Join(directory, "tailscaled.state")
	metadataPath := filepath.Join(fixture, "fixture.json")
	if phase == "baseline" {
		receipt.Stage = "create isolated baseline"
		entries, err := os.ReadDir(fixture)
		if err != nil || len(entries) != 0 {
			t.Fatal("baseline requires a new empty fixture directory", err)
		}
		// Python's Windows tempfile ACL uses OWNER RIGHTS. Elevated-created
		// receipts can then become readable only by Administrators. Give this
		// isolated test root explicit same-user access before creating children;
		// the production state directory is still prepared only by New below.
		private, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;" + user.String() + ")(A;OICI;FA;;;BA)")
		if err != nil {
			t.Fatal(err)
		}
		dacl, _, err := private.DACL()
		if err != nil {
			t.Fatal(err)
		}
		if err := windows.SetNamedSecurityInfo(fixture, windows.SE_FILE_OBJECT,
			windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
			nil, nil, dacl, nil); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(parent, 0700); err != nil {
			t.Fatal(err)
		}
		stateRestartWriteJSON(t, metadataPath, stateRestartFixture{Kind: restartFixtureKind,
			UserSID: user.String(), ParentSDDL: stateDirTestSecurity(t, parent).String()})
		receipt.Stage = "baseline complete"
		return
	}
	var metadata stateRestartFixture
	stateRestartReadJSON(t, metadataPath, &metadata)
	if metadata.Kind != restartFixtureKind || metadata.UserSID != user.String() {
		t.Fatal("test fixture marker or same-account token check failed")
	}
	if stateDirTestSecurity(t, parent).String() != metadata.ParentSDDL {
		t.Fatal("isolated parent security changed before test phase")
	}
	if phase == "elevated" {
		receipt.Stage = "create Administrators-owned state"
		sd, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;" + user.String() + ")(A;OICI;FA;;;BA)")
		if err != nil {
			t.Fatal(err)
		}
		dacl, _, err := sd.DACL()
		if err != nil {
			t.Fatal(err)
		}
		for _, target := range []string{directory, control} {
			if err := os.Mkdir(target, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(target, "tailscaled.state"), []byte(restartSavedState), 0600); err != nil {
				t.Fatal(err)
			}
			if err := windows.SetNamedSecurityInfo(target, windows.SE_FILE_OBJECT,
				windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
				admin, nil, dacl, nil); err != nil {
				t.Fatal(err)
			}
		}
		receipt.InitialOwner = stateRestartOwner(t, directory)
		if receipt.InitialOwner != admin.String() {
			t.Fatal("fixture did not reproduce Administrators ownership")
		}
	} else {
		receipt.Stage = "verify elevated initialization receipt"
		var high stateRestartReceipt
		stateRestartReadJSON(t, filepath.Join(fixture, "elevated.json"), &high)
		if !high.Passed || !high.Elevated || !high.EnabledAdmin || high.IntegritySID != "S-1-16-12288" ||
			high.UserSID != user.String() || high.FinalOwner != user.String() {
			t.Fatalf("actual elevated initialization did not pass: %+v", high)
		}
		receipt.InitialOwner = stateRestartOwner(t, directory)
		if receipt.InitialOwner != user.String() {
			t.Fatal("elevated initialization did not normalize the owner before ordinary restart")
		}
		// This directory has the old repair's private Full Control DACL but
		// deliberately retains Administrators ownership. A real normal token
		// must still reproduce the old refusal before testing the repaired one.
		receipt.Stage = "reproduce ordinary rejection of unnormalized owner"
		before := stateDirTestSecurity(t, control).String()
		if stateRestartOwner(t, control) != admin.String() {
			t.Fatal("unnormalized control lost Administrators ownership")
		}
		old, err := New(Config{StateDir: control, Hostname: "unnormalized-control"})
		if old != nil {
			old.Close()
		}
		if err == nil || !strings.Contains(err.Error(), "not owned by the current Windows user") {
			t.Fatal("ordinary token did not reproduce the old ownership refusal", err)
		}
		if stateDirTestSecurity(t, control).String() != before {
			t.Fatal("refusing unnormalized ownership changed the control directory")
		}
		receipt.ControlRejected = true
	}
	receipt.Stage = "initialize and close without starting tsnet"
	manager, err := New(Config{StateDir: directory, Hostname: "cross-token-permissions-test"})
	if err != nil {
		t.Fatal(err)
	}
	manager.Close() // Deliberately never start tsnet; early exit reproduced the bug.
	receipt.FinalOwner = stateRestartOwner(t, directory)
	if receipt.FinalOwner != user.String() {
		t.Fatalf("state directory owner remains %s instead of current user %s", receipt.FinalOwner, user)
	}
	assertPrivateStateDirACL(t, directory, user)
	if phase == "restart" {
		receipt.Stage = "open upstream Tailscale store after ordinary restart"
		state, err := store.NewFileStore(func(string, ...any) {}, saved)
		if err != nil {
			t.Fatal("ordinary restarted Tailscale cannot set owner, group and DACL", err)
		}
		if identity, err := state.ReadState("fixture"); err != nil || string(identity) != "saved network identity" {
			t.Fatal("ordinary restart cannot read the saved network identity", err)
		}
	}
	receipt.Stage = "verify saved identity and unchanged parent ACL"
	data, err := os.ReadFile(saved)
	if err != nil || string(data) != restartSavedState {
		t.Fatal("cross-token initialization or restart changed saved network identity", err)
	}
	digest := sha256.Sum256(data)
	receipt.SavedSHA256 = hex.EncodeToString(digest[:])
	if got := stateDirTestSecurity(t, parent).String(); got != metadata.ParentSDDL {
		t.Fatal("cross-token initialization or restart changed parent directory security")
	}
	receipt.Stage = fmt.Sprintf("%s complete", phase)
}
