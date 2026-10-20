package netcore

import (
	"encoding/hex"
	"reflect"
	"strings"
	"testing"
)

func TestGuardLegacyProfileValidation(t *testing.T) {
	for _, profile := range []string{"", "../profile", "A", "a b", "a;whoami", "a\"b", "--disable", "a\nstatus", strings.Repeat("a", 65)} {
		if validateGuardProfile(profile) == nil {
			t.Errorf("accepted invalid legacy profile %q", profile)
		}
	}
	for _, profile := range []string{"a", "profile-a", strings.Repeat("a", 64)} {
		if err := validateGuardProfile(profile); err != nil {
			t.Errorf("rejected legacy profile %q: %v", profile, err)
		}
	}
}

func TestGuardLegacyRuleIdentities(t *testing.T) {
	expected := strings.Fields(`
out-v4-helper out-v4-loopback out-v4-tun out-v4-dns out-v4-dot
out-v4-lan-a out-v4-lan-b out-v4-lan-c out-v4-lan-d out-v4-lan-e out-v4-lan-f out-v4-block
out-v6-helper out-v6-loopback out-v6-tun out-v6-dns out-v6-dot
out-v6-neighbor-solicit out-v6-neighbor-advertise out-v6-lan-a out-v6-lan-b out-v6-lan-c out-v6-block
in-v4-helper in-v4-loopback in-v4-tun in-v4-dns in-v4-dot
in-v4-lan-a in-v4-lan-b in-v4-lan-c in-v4-lan-d in-v4-lan-e in-v4-lan-f in-v4-block
in-v6-helper in-v6-loopback in-v6-tun in-v6-dns in-v6-dot
in-v6-neighbor-solicit in-v6-neighbor-advertise in-v6-lan-a in-v6-lan-b in-v6-lan-c in-v6-block`)
	var actual []string
	for _, rule := range guardRules() {
		actual = append(actual, rule.id)
	}
	if len(actual) != 46 || !reflect.DeepEqual(actual, expected) {
		t.Fatalf("installed legacy rule identities changed: %v", actual)
	}
}

// Recovery fixtures must keep the exact signature format written by old EXEs.
func guardRuleSignature(profile, helperPath string, rule guardRule) []byte {
	digest := guardDigest(profile, rule.id+"\x00"+helperPath)
	return []byte("ClaudeBridge.NetworkGuard.v1:" + hex.EncodeToString(digest[:]))
}

func TestGuardLegacyHashAndSignature(t *testing.T) {
	digest := guardDigest("profile-a", "sublayer")
	if actual := hex.EncodeToString(digest[:]); actual != "5e2016d73188f78dc43ca9887883b7a52369255f398c2b883b2d3052b8b3eb72" {
		t.Fatal("legacy profile hash changed", actual)
	}
	signature := string(guardRuleSignature("profile-a", `c:\missing-old-version\bridge-engine.exe`, guardRule{id: "out-v4-helper"}))
	if signature != "ClaudeBridge.NetworkGuard.v1:a24927b2a734195b3cc34d162b068aba9426f3d83b5b9ff46ec7007ba5119833" {
		t.Fatal("legacy signature fixture changed", signature)
	}
}
