package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLegacyClientLogCleanupRemovesOnlyTheLog(t *testing.T) {
	directory := t.TempDir()
	logPath := filepath.Join(directory, "client.log")
	keptPath := filepath.Join(directory, "pairing.dat")
	for _, file := range []string{logPath, keptPath} {
		if err := os.WriteFile(file, []byte("existing data"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	for range 2 {
		if err := removeLegacyClientLog(directory); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(logPath); !os.IsNotExist(err) {
		t.Fatal("legacy log remains", err)
	}
	if content, err := os.ReadFile(keptPath); err != nil || string(content) != "existing data" {
		t.Fatal("pairing data was changed", err)
	}
}

func TestLegacyClientLogCleanupKeepsDirectories(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "client.log")
	if err := os.Mkdir(target, 0700); err != nil {
		t.Fatal(err)
	}
	if err := removeLegacyClientLog(directory); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(target); err != nil || !info.IsDir() {
		t.Fatal("a directory named client.log was removed", err)
	}
}

func TestLegacyClientLogCleanupDoesNotFollowJunctions(t *testing.T) {
	for _, kind := range []string{"log", "data-directory", "parent-directory"} {
		t.Run(kind, func(t *testing.T) {
			directory, outside := t.TempDir(), t.TempDir()
			externalLog := filepath.Join(outside, "client.log")
			if err := os.WriteFile(externalLog, []byte("external data"), 0600); err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "log":
				runtimeJunction(t, filepath.Join(directory, "client.log"), outside)
			case "data-directory":
				link := filepath.Join(directory, "linked")
				runtimeJunction(t, link, outside)
				directory = link
			case "parent-directory":
				child := filepath.Join(outside, "data")
				if err := os.Mkdir(child, 0700); err != nil {
					t.Fatal(err)
				}
				externalLog = filepath.Join(child, "client.log")
				if err := os.WriteFile(externalLog, []byte("external data"), 0600); err != nil {
					t.Fatal(err)
				}
				link := filepath.Join(directory, "linked")
				runtimeJunction(t, link, outside)
				directory = filepath.Join(link, "data")
			}
			if err := removeLegacyClientLog(directory); err != nil {
				t.Fatal(err)
			}
			if content, err := os.ReadFile(externalLog); err != nil || string(content) != "external data" {
				t.Fatal("cleanup reached a junction target", err)
			}
		})
	}
}
