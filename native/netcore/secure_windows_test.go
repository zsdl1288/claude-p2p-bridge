//go:build windows

package netcore

import (
	"bytes"
	"testing"
)

func TestWindowsUserProtectedPairing(t *testing.T) {
	plaintext := []byte(`{"v":1,"secret":"private-pairing-secret"}`)
	sealed, err := protectState(plaintext, false)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(sealed, plaintext) {
		t.Fatal("saved plaintext")
	}
	recovered, err := protectState(sealed, true)
	if err != nil || !bytes.Equal(recovered, plaintext) {
		t.Fatal("DPAPI round trip failed", err)
	}
	if _, err := protectState([]byte("invalid record"), true); err == nil {
		t.Fatal("invalid DPAPI record accepted")
	}
}

func TestWindowsProtectionAcceptsItsLargestEnvelope(t *testing.T) {
	plaintext := bytes.Repeat([]byte{42}, 256*1024)
	sealed, err := protectState(plaintext, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(sealed) <= len(plaintext) {
		t.Fatal("expected the DPAPI envelope to include overhead")
	}
	recovered, err := protectState(sealed, true)
	if err != nil || !bytes.Equal(recovered, plaintext) {
		t.Fatal("the largest supported record cannot be read back", err)
	}
	if _, err := protectState(append(plaintext, 0), false); err == nil {
		t.Fatal("oversized plaintext was accepted")
	}
}
