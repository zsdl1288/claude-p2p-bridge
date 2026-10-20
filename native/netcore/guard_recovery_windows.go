//go:build windows

package netcore

import (
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

const guardRecoverySublayerPrefix = "Claude Bridge persistent network protection "
const guardRecoveryFilterPrefix = "Claude Bridge network protection "
const guardRecoverySignaturePrefix = "ClaudeBridge.NetworkGuard.v1:"

// NetworkGuardRecoveryReport describes only policy positively identified as
// belonging to Claude Bridge. Scanning never changes network policy.
type NetworkGuardRecoveryReport struct {
	Profiles          []string `json:"profiles"`
	FilterCount       int      `json:"filterCount"`
	RemovedFilters    int      `json:"removedFilters"`
	RemovedProfiles   int      `json:"removedProfiles"`
	RemainingProfiles int      `json:"remainingProfiles"`
}

type guardRecoverySublayer struct {
	key      windows.GUID
	name     string
	flags    uint32
	provider bool
	weight   uint16
}

type guardRecoveryFilter struct {
	key      windows.GUID
	name     string
	flags    uint32
	provider bool
	data     []byte
}

// Snapshot methods copy Windows-owned data before its enumeration page is freed.
// This interface also lets transaction and ownership tests avoid the real BFE.
type guardRecoveryStore interface {
	begin() error
	commit() error
	abort() error
	sublayers() ([]guardRecoverySublayer, error)
	filters(windows.GUID) ([]guardRecoveryFilter, error)
	removeFilter(windows.GUID) error
	removeSublayer(windows.GUID) error
}

type guardRecoveryTarget struct {
	profile string
	key     windows.GUID
	filters []windows.GUID
}

func guardRecoveryProfileIdentity(layer guardRecoverySublayer) (string, bool) {
	if !strings.HasPrefix(layer.name, guardRecoverySublayerPrefix) {
		return "", false
	}
	profile := strings.TrimPrefix(layer.name, guardRecoverySublayerPrefix)
	if validateGuardProfile(profile) != nil || layer.key != guardKey(profile, "sublayer") {
		return "", false
	}
	return profile, true
}

func guardRecoveryOwnedProfile(layer guardRecoverySublayer) (string, bool) {
	profile, identified := guardRecoveryProfileIdentity(layer)
	if !identified || layer.provider || layer.flags != guardPersistent || layer.weight != 0xffff {
		return "", false
	}
	return profile, true
}

func guardRecoveryOwnedFilter(profile string, filter guardRecoveryFilter) bool {
	if filter.provider {
		return false
	}
	if len(filter.data) != len(guardRecoverySignaturePrefix)+64 ||
		!strings.HasPrefix(string(filter.data), guardRecoverySignaturePrefix) {
		return false
	}
	if _, err := hex.DecodeString(string(filter.data[len(guardRecoverySignaturePrefix):])); err != nil {
		return false
	}
	for _, rule := range guardRules() {
		if filter.key == guardKey(profile, rule.id) && filter.name == guardRecoveryFilterPrefix+rule.id {
			return true
		}
	}
	return false
}

func guardRecoveryPlan(store guardRecoveryStore) ([]guardRecoveryTarget, NetworkGuardRecoveryReport, error) {
	report := NetworkGuardRecoveryReport{Profiles: []string{}}
	layers, err := store.sublayers()
	if err != nil {
		return nil, report, err
	}
	var targets []guardRecoveryTarget
	for _, layer := range layers {
		profile, identified := guardRecoveryProfileIdentity(layer)
		if !identified {
			continue
		}
		report.Profiles = append(report.Profiles, profile)
		report.RemainingProfiles++
		if _, owned := guardRecoveryOwnedProfile(layer); !owned {
			return nil, report, fmt.Errorf("unrecognized protection sublayer configuration for profile %s: provider=%t, flags=0x%04x, weight=0x%04x", profile, layer.provider, layer.flags, layer.weight)
		}
		filters, err := store.filters(layer.key)
		if err != nil {
			return nil, report, err
		}
		target := guardRecoveryTarget{profile: profile, key: layer.key}
		for _, filter := range filters {
			if !guardRecoveryOwnedFilter(profile, filter) {
				return nil, report, fmt.Errorf("refusing to remove unrecognized filter %s in protection profile %s", filter.key.String(), profile)
			}
			target.filters = append(target.filters, filter.key)
		}
		targets = append(targets, target)
		report.FilterCount += len(target.filters)
	}
	sort.Slice(targets, func(i, j int) bool { return targets[i].profile < targets[j].profile })
	sort.Strings(report.Profiles)
	report.RemainingProfiles = len(targets)
	return targets, report, nil
}

func guardRecoverWithStore(store guardRecoveryStore, restore bool) (NetworkGuardRecoveryReport, error) {
	if !restore {
		_, report, err := guardRecoveryPlan(store)
		return report, err
	}
	if err := store.begin(); err != nil {
		return NetworkGuardRecoveryReport{Profiles: []string{}}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = store.abort()
		}
	}()
	// Build the complete plan inside the transaction, before deleting anything.
	// One foreign filter in any matching profile cancels the entire operation.
	targets, report, err := guardRecoveryPlan(store)
	if err != nil {
		return report, err
	}
	for _, target := range targets {
		for _, key := range target.filters {
			if err := store.removeFilter(key); err != nil {
				return report, err
			}
		}
		if err := store.removeSublayer(target.key); err != nil {
			return report, err
		}
	}
	if err := store.commit(); err != nil {
		return report, err
	}
	committed = true
	report.RemovedFilters = report.FilterCount
	report.RemovedProfiles = len(targets)
	_, remaining, err := guardRecoveryPlan(store)
	if err != nil {
		return report, fmt.Errorf("protection removed but final verification failed: %w", err)
	}
	report.RemainingProfiles = remaining.RemainingProfiles
	if remaining.RemainingProfiles != 0 {
		return report, errors.New("network protection profiles remain after restore")
	}
	return report, nil
}

// RecoverNetworkGuard discovers all installed Claude Bridge protection profiles,
// including profiles from another data directory or executable version. Restore
// removes only that policy and does not need the old helper, AppID or TUN adapter.
func RecoverNetworkGuard(restore bool) (NetworkGuardRecoveryReport, error) {
	report := NetworkGuardRecoveryReport{Profiles: []string{}}
	if unsafe.Sizeof(uintptr(0)) != 8 {
		return report, errors.New("network protection recovery requires Windows x64")
	}
	if restore && !windows.GetCurrentProcessToken().IsElevated() {
		return report, errors.New("administrator authorization is required to restore network access")
	}
	handle, err := guardOpen()
	if err != nil {
		return report, err
	}
	defer guardEngineClose.Call(uintptr(handle))
	return guardRecoverWithStore(guardRecoveryWFPStore{handle: handle}, restore)
}

var (
	guardRecoverySublayerEnumCreate  = guardWFP.NewProc("FwpmSubLayerCreateEnumHandle0")
	guardRecoverySublayerEnum        = guardWFP.NewProc("FwpmSubLayerEnum0")
	guardRecoverySublayerEnumDestroy = guardWFP.NewProc("FwpmSubLayerDestroyEnumHandle0")
)

type guardRecoveryWFPStore struct{ handle windows.Handle }

func (store guardRecoveryWFPStore) begin() error {
	return guardCall(guardBegin, "begin recovery transaction", uintptr(store.handle), 0)
}

func (store guardRecoveryWFPStore) commit() error {
	return guardCall(guardCommit, "commit recovery transaction", uintptr(store.handle))
}

func (store guardRecoveryWFPStore) abort() error {
	return guardCall(guardAbort, "abort recovery transaction", uintptr(store.handle))
}

func (store guardRecoveryWFPStore) removeFilter(key windows.GUID) error {
	return guardCall(guardFilterDelete, "remove recovery protection filter", uintptr(store.handle), uintptr(unsafe.Pointer(&key)))
}

func (store guardRecoveryWFPStore) removeSublayer(key windows.GUID) error {
	return guardCall(guardSublayerDelete, "remove recovery protection sublayer", uintptr(store.handle), uintptr(unsafe.Pointer(&key)))
}

func (store guardRecoveryWFPStore) sublayers() ([]guardRecoverySublayer, error) {
	var enum windows.Handle
	if err := guardCall(guardRecoverySublayerEnumCreate, "create recovery sublayer enumeration", uintptr(store.handle), 0, uintptr(unsafe.Pointer(&enum))); err != nil {
		return nil, err
	}
	defer guardRecoverySublayerEnumDestroy.Call(uintptr(store.handle), uintptr(enum))
	var layers []guardRecoverySublayer
	for {
		var entries **guardSublayer
		var count uint32
		if err := guardCall(guardRecoverySublayerEnum, "enumerate recovery sublayers", uintptr(store.handle), uintptr(enum), 256, uintptr(unsafe.Pointer(&entries)), uintptr(unsafe.Pointer(&count))); err != nil {
			return nil, err
		}
		if count == 0 {
			guardFreePointer(unsafe.Pointer(entries))
			return layers, nil
		}
		if count > 256 || entries == nil {
			guardFreePointer(unsafe.Pointer(entries))
			return nil, errors.New("invalid recovery sublayer enumeration")
		}
		for _, layer := range unsafe.Slice(entries, int(count)) {
			if layer != nil {
				layers = append(layers, guardRecoverySublayer{key: layer.Key, name: windows.UTF16PtrToString(layer.Display.Name), flags: layer.Flags, provider: layer.Provider != nil, weight: layer.Weight})
			}
		}
		guardFreePointer(unsafe.Pointer(entries))
	}
}

func (store guardRecoveryWFPStore) filters(sublayer windows.GUID) ([]guardRecoveryFilter, error) {
	var filters []guardRecoveryFilter
	err := guardEnumerate(store.handle, sublayer, func(filter *guardFilter) error {
		// Signatures have one fixed length; do not copy arbitrary policy blobs.
		var data []byte
		if filter.Data.Size == uint32(len(guardRecoverySignaturePrefix)+64) && filter.Data.Data != nil {
			data = append([]byte(nil), guardBlobBytes(filter.Data)...)
		}
		filters = append(filters, guardRecoveryFilter{key: filter.Key, name: windows.UTF16PtrToString(filter.Display.Name), flags: filter.Flags, provider: filter.Provider != nil, data: data})
		return nil
	})
	return filters, err
}
