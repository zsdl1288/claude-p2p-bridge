//go:build windows

// SPDX-License-Identifier: BSD-3-Clause

// This policy is compiled only in the verified generated Tailscale module.
// Its route-metric selection follows Tailscale's Windows GetWindowsDefault.
package netmon

import (
	"fmt"

	"golang.org/x/sys/windows"
	"golang.zx2c4.com/wireguard/windows/tunnel/winipcfg"
)

func claudeBridgeDefaultUnderlay(family winipcfg.AddressFamily, interfaces []*winipcfg.IPAdapterAddresses, routes []winipcfg.MibIPforwardRow2) (*winipcfg.IPAdapterAddresses, error) {
	if family != windows.AF_INET && family != windows.AF_INET6 {
		return nil, fmt.Errorf("unsupported Windows underlay address family: %d", family)
	}
	eligible := make(map[winipcfg.LUID]*winipcfg.IPAdapterAddresses)
	for _, iface := range interfaces {
		if iface == nil || iface.IfIndex == 0 || iface.OperStatus != winipcfg.IfOperStatusUp {
			continue
		}
		switch iface.IfType {
		case winipcfg.IfTypeSoftwareLoopback, winipcfg.IfTypePropVirtual:
			continue
		}
		if family == windows.AF_INET && iface.Flags&winipcfg.IPAAFlagIpv4Enabled == 0 ||
			family == windows.AF_INET6 && iface.Flags&winipcfg.IPAAFlagIpv6Enabled == 0 {
			continue
		}
		eligible[iface.LUID] = iface
	}
	var selected *winipcfg.IPAdapterAddresses
	bestMetric := ^uint64(0)
	for _, route := range routes {
		if route.Loopback || route.DestinationPrefix.PrefixLength != 0 {
			continue
		}
		iface := eligible[route.InterfaceLUID]
		if iface == nil {
			continue
		}
		metric := uint64(route.Metric)
		if family == windows.AF_INET {
			metric += uint64(iface.Ipv4Metric)
		} else {
			metric += uint64(iface.Ipv6Metric)
		}
		if metric < bestMetric {
			selected, bestMetric = iface, metric
		}
	}
	if selected == nil {
		return nil, fmt.Errorf("no active non-virtual Windows default route for address family %d; refusing to send private-network transport through a TUN", family)
	}
	return selected, nil
}
