package main

import (
	"os"
	"path/filepath"
	"syscall"
)

// Remove only the old launcher's ordinary client.log. Never traverse a
// junction/reparse point to clean another directory or remove a directory
// that happens to have the same name.
func removeLegacyClientLog(directory string) error {
	directory, err := filepath.Abs(directory)
	if err != nil {
		return err
	}
	for current := directory; ; current = filepath.Dir(current) {
		info, err := os.Lstat(current)
		if err != nil {
			return err
		}
		if !info.IsDir() || isReparsePoint(info) {
			return nil
		}
		if filepath.Dir(current) == current {
			break
		}
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return err
	}
	defer root.Close()
	info, err := root.Lstat("client.log")
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || isReparsePoint(info) {
		return nil
	}
	return root.Remove("client.log")
}

func isReparsePoint(info os.FileInfo) bool {
	attributes, ok := info.Sys().(*syscall.Win32FileAttributeData)
	return !ok || attributes.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0
}
