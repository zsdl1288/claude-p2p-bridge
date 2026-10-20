//go:build windows

package netcore

import (
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// These checks never open BFE, request UAC or change installed policy.
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
}

func TestGuardLegacyKeys(t *testing.T) {
	for _, fixture := range []struct{ label, key string }{
		{"sublayer", "{d716205e-8831-8d57-843c-a9887883b7a5}"},
		{"out-v4-helper", "{3f718c64-6c81-255e-8047-18c5509d5fdf}"},
		{"in-v6-block", "{b0d45b61-f343-695a-ae82-d5eb5bc160ac}"},
	} {
		expected, err := windows.GUIDFromString(fixture.key)
		if err != nil {
			t.Fatal(err)
		}
		if actual := guardKey("profile-a", fixture.label); actual != expected {
			t.Fatalf("legacy %s GUID changed: %s", fixture.label, actual.String())
		}
	}
}
