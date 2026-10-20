//go:build !windows

package netcore

import "errors"

func protectState([]byte, bool) ([]byte, error) {
	return nil, errors.New("pairing protection requires Windows DPAPI")
}
