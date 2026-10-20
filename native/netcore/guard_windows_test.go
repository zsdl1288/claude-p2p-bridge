//go:build windows

package netcore

import (
	"strings"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// These tests never open the filtering engine, launch UAC or add policy rules.
func guardTestAdapter(name string, luid uint64) *windows.IpAdapterAddresses {
	friendlyName, _ := windows.UTF16PtrFromString(name)
	return &windows.IpAdapterAddresses{FriendlyName: friendlyName, IfType: 53, Luid: luid, OperStatus: windows.IfOperStatusUp}
}

func guardTestAdapterChain(adapters ...*windows.IpAdapterAddresses) *windows.IpAdapterAddresses {
	for i := 1; i < len(adapters); i++ {
		adapters[i-1].Next = adapters[i]
	}
	if len(adapters) == 0 {
		return nil
	}
	return adapters[0]
}

func TestGuardSupportsOnlyFixedTunNames(t *testing.T) {
	for _, name := range []string{"ClaudeBridgeTun", "Mihomo", "mihomo", "CLAUDEBRIDGETUN"} {
		if !supportedTunAdapterName(name) {
			t.Fatal("supported TUN name rejected", name)
		}
	}
	for _, name := range []string{"", "Ethernet", "Wi-Fi", "Mihomo 2", "OtherMihomo", " ClaudeBridgeTun"} {
		if supportedTunAdapterName(name) {
			t.Fatal("arbitrary adapter name accepted", name)
		}
	}
}

func TestGuardSelectsUniqueActiveTunWithInactiveLeftovers(t *testing.T) {
	for _, name := range []string{"ClaudeBridgeTun", "Mihomo", "mihomo"} {
		t.Run(name, func(t *testing.T) {
			stale := guardTestAdapter("ClaudeBridgeTun", 11)
			stale.OperStatus = windows.IfOperStatusDown
			live := guardTestAdapter(name, 22)
			unrelated := guardTestAdapter("Ethernet", 33)
			unrelated.IfType = 6
			first := guardTestAdapterChain(stale, unrelated, live, guardTestAdapter(name, 22))
			match, err := guardSelectTun(first)
			if err != nil || match.name != name || match.luid != 22 {
				t.Fatal("unique active Wintun was not selected", match, err)
			}
		})
	}
}

func TestGuardRejectsAbsentInvalidOrAmbiguousTun(t *testing.T) {
	physical := guardTestAdapter("Mihomo", 11)
	physical.IfType = 6
	mac := guardTestAdapter("Mihomo", 11)
	mac.PhysicalAddressLength = 6
	inactive := guardTestAdapter("Mihomo", 11)
	inactive.OperStatus = windows.IfOperStatusDown
	cases := map[string]*windows.IpAdapterAddresses{
		"absent":          nil,
		"unapproved name": guardTestAdapter("OtherTun", 11),
		"physical":        physical,
		"has MAC":         mac,
		"zero LUID":       guardTestAdapter("Mihomo", 0),
		"inactive":        inactive,
		"both names":      guardTestAdapterChain(guardTestAdapter("Mihomo", 11), guardTestAdapter("ClaudeBridgeTun", 22)),
		"duplicate name":  guardTestAdapterChain(guardTestAdapter("Mihomo", 11), guardTestAdapter("Mihomo", 22)),
	}
	for name, first := range cases {
		t.Run(name, func(t *testing.T) {
			match, err := guardSelectTun(first)
			if err == nil || match.luid != 0 || !strings.Contains(err.Error(), "ClaudeBridgeTun") || !strings.Contains(err.Error(), "Mihomo") {
				t.Fatal("invalid adapter selection was accepted or returned an unclear error", match, err)
			}
		})
	}
}

func TestGuardRecreatedTunNeedsNewLUIDPermit(t *testing.T) {
	original, err := guardSelectTun(guardTestAdapter("Mihomo", 11))
	if err != nil {
		t.Fatal(err)
	}
	recreated, err := guardSelectTun(guardTestAdapter("Mihomo", 22))
	if err != nil || recreated.name != original.name || recreated.luid == original.luid {
		t.Fatal("same name must not imply the same interface", recreated, err)
	}
	for _, rule := range guardRules() {
		if !rule.tun {
			continue
		}
		stored := guardBuildFilter("profile-a", `C:\Trusted\bridge-net.exe`, rule, nil, original.luid)
		replacement := guardBuildFilter("profile-a", `C:\Trusted\bridge-net.exe`, rule, nil, recreated.luid)
		if guardEqualFilter(&stored.filter, &replacement.filter) {
			t.Fatal("a recreated interface was authorized by the old persistent permit")
		}
	}
}

func TestGuardWindowsX64ABI(t *testing.T) {
	if unsafe.Sizeof(uintptr(0)) != 8 {
		t.Skip("x64 ABI")
	}
	if unsafe.Sizeof(guardFilter{}) != 200 || unsafe.Offsetof(guardFilter{}.Action) != 128 || unsafe.Offsetof(guardFilter{}.Context) != 152 || unsafe.Offsetof(guardFilter{}.EffectiveWeight) != 184 {
		t.Fatal("FWPM_FILTER0 layout mismatch")
	}
	if unsafe.Sizeof(guardSublayer{}) != 72 || unsafe.Offsetof(guardSublayer{}.Weight) != 64 {
		t.Fatal("FWPM_SUBLAYER0 layout mismatch")
	}
	if unsafe.Sizeof(guardCondition{}) != 40 || unsafe.Offsetof(guardCondition{}.Value) != 24 {
		t.Fatal("FWPM_FILTER_CONDITION0 layout mismatch")
	}
	if unsafe.Sizeof(guardShellInfo{}) != 112 || unsafe.Offsetof(guardShellInfo{}.Process) != 104 {
		t.Fatal("SHELLEXECUTEINFOW layout mismatch")
	}
}

func TestGuardElevationHasNoPathOrShellInput(t *testing.T) {
	if _, err := guardElevatedParameters("run", "profile-a"); err == nil {
		t.Fatal("arbitrary operation should not request UAC")
	}
	if _, err := guardElevatedParameters("enable", "a\";whoami"); err == nil {
		t.Fatal("unsafe profile")
	}
	if value, err := guardElevatedParameters("enable", "profile-a"); err != nil || value != "--network-guard enable --guard-id profile-a" {
		t.Fatal(value, err)
	}
	if value, err := guardElevatedParameters("status", "profile-a"); err != nil || value != "--network-guard status --guard-id profile-a" {
		t.Fatal(value, err)
	}
	for _, value := range []string{"", "../path", "a;whoami", "ffffffff"} {
		if _, err := guardReplyName(value); err == nil {
			t.Fatal("unsafe reply pipe identifier")
		}
	}
}

func TestGuardFilterUsesMaskEqualityAndDetectsTampering(t *testing.T) {
	appBytes := []byte{1, 2, 3, 0}
	app := guardBlob{Size: uint32(len(appBytes)), Data: &appBytes[0]}
	for _, rule := range guardRules() {
		built := guardBuildFilter("profile-a", `C:\Trusted\bridge-net.exe`, rule, &app, 0x123400005678)
		if !guardEqualFilter(&built.filter, &built.filter) {
			t.Fatal("own filter did not verify", rule.id)
		}
		if built.filter.Provider != nil || built.filter.Flags != guardPersistent {
			t.Fatal("policy must persist without a service-dependent provider")
		}
		if built.filter.ConditionCount != 0 {
			conditions := unsafe.Slice(built.filter.Conditions, int(built.filter.ConditionCount))
			for _, condition := range conditions {
				if condition.Match != 0 && condition.Match != 6 {
					t.Fatal("unsupported condition comparison")
				}
			}
		}
		changed := built.filter
		changed.Flags |= guardDisabled
		if guardEqualFilter(&changed, &built.filter) {
			t.Fatal("disabled filter was accepted")
		}
		changed = built.filter
		changed.Action.Type = 0
		if guardEqualFilter(&changed, &built.filter) {
			t.Fatal("changed action was accepted")
		}
	}
}

func TestGuardConditionIgnoresInactiveScalarUnionBytes(t *testing.T) {
	if unsafe.Sizeof(uintptr(0)) != 8 {
		t.Skip("x64 ABI")
	}
	for _, scalar := range []struct {
		kind     uint32
		inactive uintptr
	}{{guardUint8, ^uintptr(0xff)}, {guardUint16, ^uintptr(0xffff)}, {guardUint32, ^uintptr(0xffffffff)}} {
		for _, value := range []uintptr{0, 58} {
			expected := guardCondition{Key: guardCondRemotePort, Value: guardValue{Type: scalar.kind, Value: value}}
			actual := expected
			// RPC only defines the selected 1/2/4-byte integer member. The
			// remaining bytes may contain unrelated allocation contents.
			actual.Value.Value |= scalar.inactive
			if !guardEqualCondition(actual, expected) || !guardEqualCondition(expected, actual) {
				t.Fatal("inactive union bytes changed a scalar condition", scalar.kind, value)
			}
			actual.Value.Value ^= 1
			if guardEqualCondition(actual, expected) {
				t.Fatal("changed scalar value was accepted", scalar.kind, value)
			}
		}
	}
}

func TestGuardConditionStillChecksPointerValues(t *testing.T) {
	luid := uint64(0x123400005678)
	changedLUID := luid + 1
	expected := guardCondition{Key: guardCondInterface, Value: guardValue{Type: guardUint64, Value: uintptr(unsafe.Pointer(&luid))}}
	actual := expected
	actual.Value.Value = 0
	if guardEqualCondition(actual, expected) || guardEqualCondition(expected, actual) {
		t.Fatal("missing LUID pointer was accepted")
	}
	actual.Value.Value = uintptr(unsafe.Pointer(&changedLUID))
	if guardEqualCondition(actual, expected) {
		t.Fatal("changed LUID was accepted")
	}
}

func TestGuardFilterMismatchDiagnosesFlagsAndConditions(t *testing.T) {
	built := guardBuildFilter("profile-a", `C:\Trusted\bridge-net.exe`, guardRule{id: "diagnostic", family: 4, dnsPort: 53, weight: 800}, nil, 0)
	if reason := guardFilterMismatch(&built.filter, &built.filter); reason != "" || !guardEqualFilter(&built.filter, &built.filter) {
		t.Fatal("unchanged filter failed verification", reason)
	}
	changed := built.filter
	changed.Flags |= guardDisabled
	if reason := guardFilterMismatch(&changed, &built.filter); reason != "flags 0x00000021; expected 0x00000001" || guardEqualFilter(&changed, &built.filter) {
		t.Fatal("disabled filter diagnostic was inaccurate", reason)
	}
	changed = built.filter
	condition := *built.filter.Conditions
	condition.Value.Value = 54
	changed.Conditions = &condition
	if reason := guardFilterMismatch(&changed, &built.filter); !strings.Contains(reason, "condition 1 does not match") || !strings.Contains(reason, guardCondRemotePort.String()) || guardEqualFilter(&changed, &built.filter) {
		t.Fatal("changed condition diagnostic was inaccurate", reason)
	}
}

func TestGuardPermitsOriginalTargetsOnlyOnExactTunLUID(t *testing.T) {
	const luid = uint64(0x123400005678)
	seen := map[windows.GUID]bool{}
	for _, rule := range guardRules() {
		if !rule.tun {
			continue
		}
		built := guardBuildFilter("profile-a", `C:\Trusted\bridge-net.exe`, rule, nil, luid)
		if built.filter.ConditionCount != 1 {
			t.Fatal("TUN permit must be conditional")
		}
		condition := *built.filter.Conditions
		if condition.Key != guardCondInterface || condition.Match != 0 || condition.Value.Type != guardUint64 || *(*uint64)(unsafe.Pointer(condition.Value.Value)) != luid {
			t.Fatal("TUN permit could allow a physical interface")
		}
		if built.filter.Action.Type != guardPermit || rule.weight <= 800 || rule.weight >= 900 {
			t.Fatal("TUN traffic or DNS would be blocked before entering the tunnel")
		}
		seen[built.filter.Layer] = true
	}
	if len(seen) != 4 {
		t.Fatal("TUN exceptions must cover inbound/outbound IPv4/IPv6")
	}
}

func TestGuardAdministratorReplyCannotImplyAnUnverifiedState(t *testing.T) {
	valid := []byte(`{"supported":true,"profileId":"profile-a","enabled":true,"state":"enabled","filterCount":46,"expectedFilters":46}`)
	if result, err := guardDecodeReply(valid, "profile-a"); err != nil || !result.Enabled {
		t.Fatal(result, err)
	}
	if _, err := guardDecodeReply(valid, "other-profile"); err == nil {
		t.Fatal("wrong-profile reply accepted")
	}
	for _, reply := range [][]byte{[]byte(`{"supported":true,"profileId":"other","enabled":false,"state":"disabled"}`), []byte(`{"supported":true,"profileId":"profile-a","enabled":true,"state":"disabled"}`), []byte(`{"supported":true,"profileId":"profile-a","enabled":true,"state":"enabled","filterCount":45,"expectedFilters":46}`), []byte(`{"error":"access denied","status":{"profileId":"profile-a","state":"unknown"}}`), []byte(`invalid`)} {
		if _, err := guardDecodeReply(reply, "profile-a"); err == nil {
			t.Fatal("unverified or wrong-profile reply accepted")
		}
	}
}

func TestGuardReplyPipeReturnsRealLocalClientPID(t *testing.T) {
	pipe, nonce, err := guardCreateReplyPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(pipe)
	connectErr := windows.ConnectNamedPipe(pipe, nil)
	if connectErr != nil && connectErr != windows.ERROR_PIPE_LISTENING && connectErr != windows.ERROR_PIPE_CONNECTED {
		t.Fatal(connectErr)
	}
	name, _ := guardReplyName(nonce)
	pipeName, _ := windows.UTF16PtrFromString(name)
	client, err := windows.CreateFile(pipeName, windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(client)
	var pid uint32
	if err := windows.GetNamedPipeClientProcessId(pipe, &pid); err != nil || pid != windows.GetCurrentProcessId() {
		t.Fatal("local client process identity was not verified", pid, err)
	}
	payload := []byte(`{"supported":true,"profileId":"profile-a","state":"disabled","enabled":false,"filterCount":0,"expectedFilters":46}`)
	var written uint32
	if err := windows.WriteFile(client, payload, &written, nil); err != nil || written != uint32(len(payload)) {
		t.Fatal(written, err)
	}
	buffer := make([]byte, 4096)
	var done uint32
	err = windows.ReadFile(pipe, buffer, &done, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result, err := guardDecodeReply(buffer[:done], "profile-a"); err != nil || result.State != "disabled" {
		t.Fatal(result, err)
	}
}
