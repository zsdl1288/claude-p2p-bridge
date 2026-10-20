//go:build !windows

package netcore

import "os"

func prepareStateDir(stateDir string) error {
	return os.MkdirAll(stateDir, 0700)
}
