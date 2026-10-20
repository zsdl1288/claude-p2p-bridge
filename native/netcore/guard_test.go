package netcore

import (
	"bytes"
	"testing"
)

func TestGuardCommandRejectsPathsAndShellArguments(t *testing.T) {
	for _, profile := range []string{"", "../profile", "A", "a b", "a;whoami", "a\"b", "--disable", "a\nstatus"} {
		if _, err := guardCLIArguments("enable", profile); err == nil {
			t.Errorf("accepted profile %q", profile)
		}
	}
	for _, action := range []string{"", "Enable", "enable;whoami", "run"} {
		if _, err := guardCLIArguments(action, "profile-a"); err == nil {
			t.Errorf("accepted action %q", action)
		}
	}
	args, err := guardCLIArguments("enable", "profile-a")
	if err != nil || len(args) != 4 || args[1] != "enable" || args[3] != "profile-a" {
		t.Fatal(args, err)
	}
	var output bytes.Buffer
	if handled, exit := RunNetworkGuardCLI([]string{"--network-guard", "enable", "--guard-id", "a", "extra"}, &output); !handled || exit == 0 {
		t.Fatal("malformed mutation command was accepted")
	}
}

func TestGuardPolicyOrdersDNSBeforeLANAndAllowsOnlyHelperGlobally(t *testing.T) {
	counts := map[string]int{}
	for _, rule := range guardRules() {
		if counts[rule.id] != 0 {
			t.Fatal("duplicate rule", rule.id)
		}
		counts[rule.id]++
		if rule.permit && !rule.self && !rule.loopback && !rule.tun && !rule.prefix.IsValid() && rule.ndpType == 0 {
			t.Fatal("unrestricted permit", rule.id)
		}
		if rule.dnsPort != 0 && (rule.permit || rule.weight <= 500 || rule.weight >= 900) {
			t.Fatal("DNS can escape through a LAN exception")
		}
		if rule.prefix.IsValid() && (rule.prefix.Bits() == 0 || (rule.prefix.Addr().Is4() != (rule.family == 4))) {
			t.Fatal("invalid LAN prefix", rule.id)
		}
		if rule.self && (!rule.permit || rule.weight <= 900) {
			t.Fatal("helper cannot bootstrap")
		}
	}
	if len(counts) != 46 {
		t.Fatalf("unexpected rule coverage: %d", len(counts))
	}
}
