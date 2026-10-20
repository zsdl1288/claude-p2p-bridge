//go:build windows

package netmon

import (
	"net/netip"
	"testing"

	"golang.org/x/sys/windows"
	"golang.zx2c4.com/wireguard/windows/tunnel/winipcfg"
)

func claudeBridgeTestAdapter(index uint32, kind winipcfg.IfType, metric uint32) *winipcfg.IPAdapterAddresses {
	return &winipcfg.IPAdapterAddresses{IfIndex: index, LUID: winipcfg.LUID(index), IfType: kind,
		OperStatus: winipcfg.IfOperStatusUp, Ipv4Metric: metric, Ipv6Metric: metric,
		Flags: winipcfg.IPAAFlagIpv4Enabled | winipcfg.IPAAFlagIpv6Enabled}
}

func claudeBridgeTestRoute(t *testing.T, index uint32, prefix string, metric uint32) winipcfg.MibIPforwardRow2 {
	t.Helper()
	row := winipcfg.MibIPforwardRow2{InterfaceLUID: winipcfg.LUID(index), InterfaceIndex: index, Metric: metric}
	if err := row.DestinationPrefix.SetPrefix(netip.MustParsePrefix(prefix)); err != nil {
		t.Fatal(err)
	}
	return row
}

func TestClaudeBridgeUnderlayRejectsLowerMetricTun(t *testing.T) {
	tun := claudeBridgeTestAdapter(42, winipcfg.IfTypePropVirtual, 0)
	wlan := claudeBridgeTestAdapter(9, winipcfg.IfTypeIEEE80211, 50)
	for _, family := range []winipcfg.AddressFamily{windows.AF_INET, windows.AF_INET6} {
		prefix := "0.0.0.0/0"
		if family == windows.AF_INET6 {
			prefix = "::/0"
		}
		got, err := claudeBridgeDefaultUnderlay(family, []*winipcfg.IPAdapterAddresses{tun, wlan},
			[]winipcfg.MibIPforwardRow2{claudeBridgeTestRoute(t, 42, prefix, 0), claudeBridgeTestRoute(t, 9, prefix, 100)})
		if err != nil || got != wlan {
			t.Fatalf("family %d: selected %v, want WLAN, error %v", family, got, err)
		}
	}
}

func TestClaudeBridgeUnderlayUsesEffectiveDefaultMetric(t *testing.T) {
	a := claudeBridgeTestAdapter(9, winipcfg.IfTypeIEEE80211, 50)
	b := claudeBridgeTestAdapter(10, winipcfg.IfTypeEthernetCSMACD, 5)
	got, err := claudeBridgeDefaultUnderlay(windows.AF_INET, []*winipcfg.IPAdapterAddresses{a, b},
		[]winipcfg.MibIPforwardRow2{claudeBridgeTestRoute(t, 9, "0.0.0.0/0", 0),
			claudeBridgeTestRoute(t, 10, "0.0.0.0/0", 100), claudeBridgeTestRoute(t, 10, "128.0.0.0/1", 0)})
	if err != nil || got != a {
		t.Fatalf("selected %v, want lower combined default metric on WLAN, error %v", got, err)
	}
}

func TestClaudeBridgeUnderlayFailsWithoutUsableInterface(t *testing.T) {
	for _, kind := range []winipcfg.IfType{winipcfg.IfTypePropVirtual, winipcfg.IfTypeSoftwareLoopback} {
		iface := claudeBridgeTestAdapter(42, kind, 0)
		if got, err := claudeBridgeDefaultUnderlay(windows.AF_INET, []*winipcfg.IPAdapterAddresses{iface},
			[]winipcfg.MibIPforwardRow2{claudeBridgeTestRoute(t, 42, "0.0.0.0/0", 0)}); err == nil || got != nil {
			t.Fatalf("virtual interface type %d must fail, selected %v, error %v", kind, got, err)
		}
	}
	for _, state := range []string{"down", "disabled-family", "unbound-index"} {
		iface := claudeBridgeTestAdapter(9, winipcfg.IfTypeIEEE80211, 10)
		switch state {
		case "down":
			iface.OperStatus = winipcfg.IfOperStatusDown
		case "disabled-family":
			iface.Flags = winipcfg.IPAAFlagIpv6Enabled
		case "unbound-index":
			iface.IfIndex = 0
		}
		if got, err := claudeBridgeDefaultUnderlay(windows.AF_INET, []*winipcfg.IPAdapterAddresses{iface},
			[]winipcfg.MibIPforwardRow2{claudeBridgeTestRoute(t, 9, "0.0.0.0/0", 0)}); err == nil || got != nil {
			t.Fatalf("%s interface must fail, selected %v, error %v", state, got, err)
		}
	}
}

func TestClaudeBridgeUnderlayIPv6AbsenceDoesNotChangeIPv4(t *testing.T) {
	iface := claudeBridgeTestAdapter(9, winipcfg.IfTypeIEEE80211, 10)
	iface.Flags = winipcfg.IPAAFlagIpv4Enabled
	interfaces := []*winipcfg.IPAdapterAddresses{iface}
	if got, err := claudeBridgeDefaultUnderlay(windows.AF_INET6, interfaces, nil); err == nil || got != nil {
		t.Fatalf("missing IPv6 underlay must fail explicitly, selected %v, error %v", got, err)
	}
	got, err := claudeBridgeDefaultUnderlay(windows.AF_INET, interfaces,
		[]winipcfg.MibIPforwardRow2{claudeBridgeTestRoute(t, 9, "0.0.0.0/0", 0)})
	if err != nil || got != iface {
		t.Fatalf("IPv4 route must remain usable, selected %v, error %v", got, err)
	}
}
