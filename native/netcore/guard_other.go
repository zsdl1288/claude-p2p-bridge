//go:build !windows

package netcore

import (
	"errors"
	"io"
)

func guardOpenReply(nonce string) (io.WriteCloser, error) {
	return nil, errors.New("network guard reply pipes require Windows")
}

func runNetworkGuard(action, profile string) (NetworkGuardStatus, error) {
	status := NetworkGuardStatus{ProfileID: profile, State: "unsupported", Scope: "windows-bfe-runtime"}
	if action == "status" {
		return status, nil
	}
	return status, errors.New("persistent network guard requires Windows 10/11 x64")
}
