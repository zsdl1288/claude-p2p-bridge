package main

import (
	"bridge.local/client/netcore"
	"os"
)

func main() {
	netcore.ConfigureBootstrapNetwork()
	if err := netcore.Run(os.Stdin, os.Stdout); err != nil {
		os.Exit(1)
	}
}
