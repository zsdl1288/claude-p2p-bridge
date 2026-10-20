package main

import (
	"bridge.local/client/netcore"
	"os"
)

func main() {
	if handled, exit := netcore.RunNetworkGuardCLI(os.Args[1:], os.Stdout); handled {
		os.Exit(exit)
	}
	netcore.ConfigureBootstrapNetwork()
	if err := netcore.Run(os.Stdin, os.Stdout); err != nil {
		os.Exit(1)
	}
}
