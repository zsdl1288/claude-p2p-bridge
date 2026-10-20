package netcore

import (
	"crypto/sha256"
	"errors"
	"regexp"
)

// Legacy profile names are opaque identifiers, never paths or commands.
var guardProfilePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

func validateGuardProfile(profile string) error {
	if !guardProfilePattern.MatchString(profile) {
		return errors.New("invalid network guard profile: use 1-64 lowercase letters, digits or hyphens")
	}
	return nil
}

// Only historical identities remain; no policy can be installed by this code.
type guardRule struct{ id string }

// These 46 IDs are part of the installed WFP GUIDs. Preserve their names and
// order so offline recovery recognizes rules written by earlier releases.
func guardRules() []guardRule {
	var rules []guardRule
	for _, direction := range []string{"out", "in"} {
		for _, family := range []string{"v4", "v6"} {
			names := []string{"helper", "loopback", "tun", "dns", "dot"}
			lanCount := 6
			if family == "v6" {
				names = append(names, "neighbor-solicit", "neighbor-advertise")
				lanCount = 3
			}
			for index := 0; index < lanCount; index++ {
				names = append(names, "lan-"+string(rune('a'+index)))
			}
			names = append(names, "block")
			for _, name := range names {
				rules = append(rules, guardRule{id: direction + "-" + family + "-" + name})
			}
		}
	}
	return rules
}

func guardDigest(profile, label string) [32]byte {
	return sha256.Sum256([]byte("ClaudeBridge.NetworkGuard.v1\x00" + profile + "\x00" + label))
}
