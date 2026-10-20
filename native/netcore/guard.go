package netcore

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/netip"
	"regexp"
)

// A profile is an opaque identifier, never a path, command, token or account ID.
var guardProfilePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
var guardReplyPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type NetworkGuardStatus struct {
	Supported       bool     `json:"supported"`
	ProfileID       string   `json:"profileId"`
	State           string   `json:"state"`
	Enabled         bool     `json:"enabled"`
	FilterCount     int      `json:"filterCount"`
	ExpectedFilters int      `json:"expectedFilters"`
	HelperPath      string   `json:"helperPath,omitempty"`
	Issues          []string `json:"issues,omitempty"`
	// Persistent policy is active after BFE starts, not during early boot.
	Scope    string `json:"scope"`
	AllowLAN bool   `json:"allowLan"`
	TunName  string `json:"tunName"`
	TunReady bool   `json:"tunReady"`
	TunLUID  string `json:"tunLuid,omitempty"`
}

func validateGuardProfile(profile string) error {
	if !guardProfilePattern.MatchString(profile) {
		return errors.New("invalid network guard profile: use 1-64 lowercase letters, digits or hyphens")
	}
	return nil
}

type guardRule struct {
	id       string
	family   int
	inbound  bool
	permit   bool
	weight   uint64
	self     bool
	loopback bool
	tun      bool
	prefix   netip.Prefix
	dnsPort  uint16
	ndpType  uint16
}

// Exceptions live in the same sublayer as the catch-all block. AppID uses only
// equality, CIDRs use address-mask equality; unsupported NOT_EQUAL/mask or
// negative app matching is deliberately not relied on.
func guardRules() []guardRule {
	var rules []guardRule
	for _, inbound := range []bool{false, true} {
		for _, family := range []int{4, 6} {
			direction := "out"
			if inbound {
				direction = "in"
			}
			base := direction + "-v" + string(rune('0'+family)) + "-"
			add := func(rule guardRule) {
				rule.id = base + rule.id
				rule.family = family
				rule.inbound = inbound
				rules = append(rules, rule)
			}
			add(guardRule{id: "helper", permit: true, weight: 1000, self: true})
			add(guardRule{id: "loopback", permit: true, weight: 900, loopback: true})
			// A TUN application's ALE remote address is still the original public
			// target. Permit only the protected TUN interface, never the proxy
			// process itself; otherwise a DIRECT fallback could escape.
			add(guardRule{id: "tun", permit: true, weight: 850, tun: true})
			// Block DNS before LAN permits, including a router's DNS service.
			// Encrypted DNS over arbitrary HTTPS is covered by the public block.
			add(guardRule{id: "dns", weight: 800, dnsPort: 53})
			add(guardRule{id: "dot", weight: 800, dnsPort: 853})
			prefixes := []string{"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "224.0.0.0/24", "255.255.255.255/32"}
			if family == 6 {
				prefixes = []string{"fc00::/7", "fe80::/10", "ff02::/16"}
				// IPv6 neighbors can advertise a global source address. These are
				// link maintenance messages, not an unrestricted ICMP exception.
				add(guardRule{id: "neighbor-solicit", permit: true, weight: 700, ndpType: 135})
				add(guardRule{id: "neighbor-advertise", permit: true, weight: 700, ndpType: 136})
			}
			for index, cidr := range prefixes {
				add(guardRule{id: "lan-" + string(rune('a'+index)), permit: true, weight: 500, prefix: netip.MustParsePrefix(cidr)})
			}
			add(guardRule{id: "block", weight: 1})
		}
	}
	return rules
}

func guardDigest(profile, label string) [32]byte {
	return sha256.Sum256([]byte("ClaudeBridge.NetworkGuard.v1\x00" + profile + "\x00" + label))
}

func guardRuleSignature(profile, helperPath string, rule guardRule) []byte {
	digest := guardDigest(profile, rule.id+"\x00"+helperPath)
	return []byte("ClaudeBridge.NetworkGuard.v1:" + hex.EncodeToString(digest[:]))
}

func guardCLIArguments(action, profile string) ([]string, error) {
	if err := validateGuardProfile(profile); err != nil {
		return nil, err
	}
	switch action {
	case "enable", "disable", "status", "elevate-enable", "elevate-disable", "elevate-status":
		return []string{"--network-guard", action, "--guard-id", profile}, nil
	default:
		return nil, errors.New("invalid network guard action")
	}
}

// RunNetworkGuardCLI handles only the dedicated, fixed-argument interface. Its
// mutation commands are never dispatched by the normal network stdio RPC.
func RunNetworkGuardCLI(args []string, output io.Writer) (bool, int) {
	if len(args) == 0 || args[0] != "--network-guard" {
		return false, 0
	}
	var result NetworkGuardStatus
	var err error
	validLength := len(args) == 4 || (len(args) == 6 && args[4] == "--guard-reply" && guardReplyPattern.MatchString(args[5]))
	if !validLength || args[2] != "--guard-id" {
		err = errors.New("usage: --network-guard enable|disable|status|elevate-enable|elevate-disable --guard-id PROFILE")
	} else if _, err = guardCLIArguments(args[1], args[3]); err == nil {
		if len(args) == 6 {
			// Reply pipes are created by the normal helper, not filesystem paths.
			// Connect and verify that helper before applying any privileged policy.
			var reply io.WriteCloser
			reply, err = guardOpenReply(args[5])
			if err == nil {
				defer reply.Close()
				output = reply
			}
		}
		if err == nil {
			result, err = runNetworkGuard(args[1], args[3])
		}
	}
	if err != nil {
		_ = json.NewEncoder(output).Encode(map[string]any{"error": err.Error(), "status": result})
		return true, 1
	}
	_ = json.NewEncoder(output).Encode(result)
	return true, 0
}
