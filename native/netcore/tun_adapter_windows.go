//go:build windows

package netcore

import "strings"

func supportedTunAdapterName(name string) bool {
	return strings.EqualFold(name, "ClaudeBridgeTun") || strings.EqualFold(name, "Mihomo")
}
