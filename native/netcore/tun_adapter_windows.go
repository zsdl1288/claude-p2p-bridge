//go:build windows

package netcore

import (
	"errors"
	"strings"

	"golang.org/x/sys/windows"
)

type guardTunAdapter struct {
	name string
	luid uint64
}

func supportedTunAdapterName(name string) bool {
	return strings.EqualFold(name, "ClaudeBridgeTun") || strings.EqualFold(name, "Mihomo")
}

// Accept only a uniquely active Wintun interface with a supported fixed name.
// Inactive leftovers do not hide the live interface; the selected LUID, rather
// than its reusable name, is what the persistent protection rules authorize.
func guardSelectTun(first *windows.IpAdapterAddresses) (guardTunAdapter, error) {
	var match guardTunAdapter
	for adapter := first; adapter != nil; adapter = adapter.Next {
		name := windows.UTF16PtrToString(adapter.FriendlyName)
		if !supportedTunAdapterName(name) || adapter.OperStatus != windows.IfOperStatusUp {
			continue
		}
		// IfType 53 is IANA propVirtual (Wintun), not Ethernet or Wi-Fi.
		if adapter.IfType != 53 || adapter.PhysicalAddressLength != 0 || adapter.Luid == 0 {
			return guardTunAdapter{}, errors.New("Clash TUN 网卡必须是有效的 Wintun 虚拟网卡（支持 ClaudeBridgeTun 或 Mihomo）")
		}
		if match.luid != 0 && match.luid != adapter.Luid {
			return guardTunAdapter{}, errors.New("检测到多个可用的 Clash TUN 网卡（ClaudeBridgeTun / Mihomo）；请仅保留一个启用的 TUN 后重试")
		}
		if match.luid == 0 {
			match = guardTunAdapter{name: name, luid: adapter.Luid}
		}
	}
	if match.luid == 0 {
		return match, errors.New("未找到可用的 Clash TUN 网卡；请先开启 TUN 模式（支持 ClaudeBridgeTun 或 Mihomo）")
	}
	return match, nil
}
