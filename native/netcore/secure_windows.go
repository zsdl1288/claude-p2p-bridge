//go:build windows

package netcore

import (
	"errors"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Protect pairing credentials for the current Windows user, with no UI or
// machine-wide decryption flag. Secrets travel only through private stdio.
func protectState(data []byte, decrypt bool) ([]byte, error) {
	const plaintextLimit = 256 * 1024
	// A DPAPI envelope is larger than its plaintext. Do not reject our own
	// largest valid records when reading them back.
	limit := plaintextLimit
	if decrypt {
		limit += 16 * 1024
	}
	if len(data) == 0 || len(data) > limit {
		return nil, errors.New("invalid protected state size")
	}
	entropy := []byte("ClaudeBridge.Pairing.v1")
	input := windows.DataBlob{Size: uint32(len(data)), Data: &data[0]}
	domain := windows.DataBlob{Size: uint32(len(entropy)), Data: &entropy[0]}
	var output windows.DataBlob
	var err error
	if decrypt {
		err = windows.CryptUnprotectData(&input, nil, &domain, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &output)
	} else {
		err = windows.CryptProtectData(&input, nil, &domain, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &output)
	}
	if err != nil {
		return nil, errors.New("Windows account protection failed; use the original user profile or pair again")
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(output.Data)))
	buffer := unsafe.Slice(output.Data, int(output.Size))
	defer clear(buffer)
	if decrypt && len(buffer) > plaintextLimit {
		return nil, errors.New("invalid protected state size")
	}
	return append([]byte(nil), buffer...), nil
}
