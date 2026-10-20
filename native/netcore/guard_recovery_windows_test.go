//go:build windows

package netcore

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

// No test opens BFE or changes policy. The fake keeps a transaction snapshot so
// rollback tests check the resulting policy as well as the invoked operations.
type guardRecoveryFake struct {
	layers            []guardRecoverySublayer
	filterByLayer     map[windows.GUID][]guardRecoveryFilter
	originalLayers    []guardRecoverySublayer
	originalFilters   map[windows.GUID][]guardRecoveryFilter
	calls             []string
	fail              string
	removeCount       int
	active            bool
	injectAfterCommit bool
}

func guardRecoveryTestLayer(profile string) guardRecoverySublayer {
	return guardRecoverySublayer{key: guardKey(profile, "sublayer"), name: guardRecoverySublayerPrefix + profile, flags: guardPersistent, weight: 0xffff}
}

func guardRecoveryTestFilter(profile string, rule guardRule) guardRecoveryFilter {
	return guardRecoveryFilter{key: guardKey(profile, rule.id), name: guardRecoveryFilterPrefix + rule.id,
		flags: guardPersistent | guardIndexed, data: guardRuleSignature(profile, `c:\missing-old-version\bridge-engine.exe`, rule)}
}

func guardRecoveryTestStore() *guardRecoveryFake {
	a, b, other := guardRecoveryTestLayer("profile-a"), guardRecoveryTestLayer("profile-b"), guardRecoveryTestLayer("another-app")
	other.name = "Other firewall policy"
	return &guardRecoveryFake{layers: []guardRecoverySublayer{b, other, a}, filterByLayer: map[windows.GUID][]guardRecoveryFilter{
		a.key:     {guardRecoveryTestFilter("profile-a", guardRules()[0]), guardRecoveryTestFilter("profile-a", guardRules()[1])},
		b.key:     {guardRecoveryTestFilter("profile-b", guardRules()[0])},
		other.key: {{key: guardKey("foreign", "rule"), name: "Other rule", data: []byte("foreign policy")}},
	}}
}

func guardRecoveryCopyFilters(source map[windows.GUID][]guardRecoveryFilter) map[windows.GUID][]guardRecoveryFilter {
	copy := make(map[windows.GUID][]guardRecoveryFilter, len(source))
	for key, filters := range source {
		copy[key] = append([]guardRecoveryFilter(nil), filters...)
	}
	return copy
}

func (store *guardRecoveryFake) begin() error {
	store.calls = append(store.calls, "begin")
	if store.fail == "begin" {
		return errors.New("begin failed")
	}
	store.active = true
	store.originalLayers = append([]guardRecoverySublayer(nil), store.layers...)
	store.originalFilters = guardRecoveryCopyFilters(store.filterByLayer)
	return nil
}

func (store *guardRecoveryFake) commit() error {
	store.calls = append(store.calls, "commit")
	if store.fail == "commit" {
		return errors.New("commit failed")
	}
	store.active = false
	if store.injectAfterCommit {
		layer := guardRecoveryTestLayer("profile-new")
		store.layers = append(store.layers, layer)
		store.filterByLayer[layer.key] = []guardRecoveryFilter{guardRecoveryTestFilter("profile-new", guardRules()[0])}
	}
	return nil
}

func (store *guardRecoveryFake) abort() error {
	store.calls = append(store.calls, "abort")
	store.layers = store.originalLayers
	store.filterByLayer = store.originalFilters
	store.active = false
	return nil
}

func (store *guardRecoveryFake) sublayers() ([]guardRecoverySublayer, error) {
	if store.fail == "enumerate" {
		return nil, errors.New("enumeration failed")
	}
	return store.layers, nil
}

func (store *guardRecoveryFake) filters(key windows.GUID) ([]guardRecoveryFilter, error) {
	if store.fail == "filters" {
		return nil, errors.New("filter enumeration failed")
	}
	return store.filterByLayer[key], nil
}

func (store *guardRecoveryFake) removeFilter(key windows.GUID) error {
	if !store.active {
		return errors.New("deletion outside transaction")
	}
	store.removeCount++
	store.calls = append(store.calls, "remove-filter")
	if store.fail == fmt.Sprintf("filter-%d", store.removeCount) {
		return errors.New("filter removal failed")
	}
	for layer, filters := range store.filterByLayer {
		for i, filter := range filters {
			if filter.key == key {
				kept := append([]guardRecoveryFilter(nil), filters[:i]...)
				store.filterByLayer[layer] = append(kept, filters[i+1:]...)
				return nil
			}
		}
	}
	return errors.New("filter not found")
}

func (store *guardRecoveryFake) removeSublayer(key windows.GUID) error {
	if !store.active {
		return errors.New("deletion outside transaction")
	}
	store.calls = append(store.calls, "remove-sublayer")
	if store.fail == "sublayer" {
		return errors.New("sublayer removal failed")
	}
	if len(store.filterByLayer[key]) != 0 {
		return errors.New("sublayer still has filters")
	}
	for i, layer := range store.layers {
		if layer.key == key {
			kept := append([]guardRecoverySublayer(nil), store.layers[:i]...)
			store.layers = append(kept, store.layers[i+1:]...)
			delete(store.filterByLayer, key)
			return nil
		}
	}
	return errors.New("sublayer not found")
}

func TestGuardRecoverySublayerOwnershipRequiresAllMarkers(t *testing.T) {
	layer := guardRecoveryTestLayer("profile-a")
	if profile, owned := guardRecoveryOwnedProfile(layer); !owned || profile != "profile-a" {
		t.Fatal("own profile was not identified")
	}
	for _, change := range []struct {
		name string
		edit func(*guardRecoverySublayer)
	}{
		{"name", func(layer *guardRecoverySublayer) { layer.name = "Other protection profile-a" }},
		{"invalid-profile", func(layer *guardRecoverySublayer) { layer.name = guardRecoverySublayerPrefix + "../profile" }},
		{"wrong-key", func(layer *guardRecoverySublayer) { layer.key = guardKey("profile-b", "sublayer") }},
		{"provider", func(layer *guardRecoverySublayer) { layer.provider = true }},
		{"flags", func(layer *guardRecoverySublayer) { layer.flags = 0 }},
		{"weight", func(layer *guardRecoverySublayer) { layer.weight = 1 }},
	} {
		t.Run(change.name, func(t *testing.T) {
			changed := layer
			change.edit(&changed)
			if _, owned := guardRecoveryOwnedProfile(changed); owned {
				t.Fatal("foreign sublayer was identified as owned")
			}
		})
	}
}

func TestGuardRecoveryIdentifiedSublayerWithUnexpectedMetadataFails(t *testing.T) {
	for _, change := range []struct {
		name string
		edit func(*guardRecoverySublayer)
	}{
		{"provider", func(layer *guardRecoverySublayer) { layer.provider = true }},
		{"flags", func(layer *guardRecoverySublayer) { layer.flags = 0 }},
		{"weight", func(layer *guardRecoverySublayer) { layer.weight = 1 }},
	} {
		for _, restore := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/restore=%t", change.name, restore), func(t *testing.T) {
				store := guardRecoveryTestStore()
				change.edit(&store.layers[0]) // profile-b, before any valid profile.
				layers, filters := append([]guardRecoverySublayer(nil), store.layers...), guardRecoveryCopyFilters(store.filterByLayer)
				report, err := guardRecoverWithStore(store, restore)
				if err == nil || !strings.Contains(err.Error(), "unrecognized protection sublayer configuration") ||
					report.RemainingProfiles == 0 || report.RemovedProfiles != 0 || report.RemovedFilters != 0 {
					t.Fatal("identified but damaged profile was reported as absent or restored", report, err)
				}
				if !reflect.DeepEqual(store.layers, layers) || !reflect.DeepEqual(store.filterByLayer, filters) {
					t.Fatal("unrecognized sublayer configuration changed policy")
				}
				if restore && !reflect.DeepEqual(store.calls, []string{"begin", "abort"}) || !restore && len(store.calls) != 0 {
					t.Fatal("unexpected transaction behavior", store.calls)
				}
			})
		}
	}
}

func TestGuardRecoveryUnidentifiedSublayersRemainUntouched(t *testing.T) {
	for _, change := range []struct {
		name string
		edit func(*guardRecoverySublayer)
	}{
		{"prefix", func(layer *guardRecoverySublayer) { layer.name = "Other policy" }},
		{"profile", func(layer *guardRecoverySublayer) { layer.name = guardRecoverySublayerPrefix + "../invalid" }},
		{"key", func(layer *guardRecoverySublayer) { layer.key = guardKey("other-profile", "sublayer") }},
	} {
		t.Run(change.name, func(t *testing.T) {
			layer := guardRecoveryTestLayer("profile-a")
			change.edit(&layer)
			store := &guardRecoveryFake{layers: []guardRecoverySublayer{layer}, filterByLayer: map[windows.GUID][]guardRecoveryFilter{
				layer.key: {{key: guardKey("foreign", "rule"), name: "Other rule"}},
			}}
			report, err := guardRecoverWithStore(store, true)
			if err != nil || report.RemovedProfiles != 0 || report.FilterCount != 0 || len(store.layers) != 1 || store.layers[0] != layer || len(store.filterByLayer[layer.key]) != 1 {
				t.Fatal("unidentified policy was affected", report, err)
			}
		})
	}
}

func TestGuardRecoveryFilterOwnershipIgnoresStaleRuntimePolicy(t *testing.T) {
	for _, rule := range guardRules() {
		filter := guardRecoveryTestFilter("profile-a", rule)
		// Recovery must still remove indexed, disabled or otherwise damaged
		// policy. Its identity, rather than its current effectiveness, matters.
		for _, flags := range []uint32{0, guardPersistent, guardPersistent | guardIndexed, guardPersistent | guardDisabled, 0xffffffff} {
			filter.flags = flags
			if !guardRecoveryOwnedFilter("profile-a", filter) {
				t.Fatal("own old helper filter was rejected", rule.id, flags)
			}
		}
		if guardRecoveryOwnedFilter("profile-b", filter) {
			t.Fatal("filter from another profile was accepted", rule.id)
		}
	}
}

func TestGuardRecoveryRejectsForeignFilterMarkers(t *testing.T) {
	filter := guardRecoveryTestFilter("profile-a", guardRules()[0])
	for _, change := range []struct {
		name string
		edit func(*guardRecoveryFilter)
	}{
		{"key", func(filter *guardRecoveryFilter) { filter.key = guardKey("profile-a", "foreign") }},
		{"name", func(filter *guardRecoveryFilter) { filter.name = "Other filter" }},
		{"provider", func(filter *guardRecoveryFilter) { filter.provider = true }},
		{"prefix", func(filter *guardRecoveryFilter) { filter.data = []byte("Other.v1:" + strings.Repeat("0", 64)) }},
		{"short-hash", func(filter *guardRecoveryFilter) {
			filter.data = []byte(guardRecoverySignaturePrefix + strings.Repeat("0", 63))
		}},
		{"invalid-hex", func(filter *guardRecoveryFilter) {
			filter.data = []byte(guardRecoverySignaturePrefix + strings.Repeat("z", 64))
		}},
		{"suffix", func(filter *guardRecoveryFilter) { filter.data = append(append([]byte(nil), filter.data...), 0) }},
	} {
		t.Run(change.name, func(t *testing.T) {
			changed := filter
			change.edit(&changed)
			if guardRecoveryOwnedFilter("profile-a", changed) {
				t.Fatal("foreign filter was accepted")
			}
		})
	}
}

func TestGuardRecoveryScanIsReadOnlyAcrossProfiles(t *testing.T) {
	store := guardRecoveryTestStore()
	layers, filters := append([]guardRecoverySublayer(nil), store.layers...), guardRecoveryCopyFilters(store.filterByLayer)
	report, err := guardRecoverWithStore(store, false)
	if err != nil || !reflect.DeepEqual(report.Profiles, []string{"profile-a", "profile-b"}) || report.FilterCount != 3 || report.RemainingProfiles != 2 || report.RemovedFilters != 0 || report.RemovedProfiles != 0 {
		t.Fatal("incorrect scan", report, err)
	}
	if len(store.calls) != 0 || !reflect.DeepEqual(layers, store.layers) || !reflect.DeepEqual(filters, store.filterByLayer) {
		t.Fatal("scan changed policy")
	}
}

func TestGuardRecoveryRestoresAllProfilesAndPreservesForeignPolicy(t *testing.T) {
	store := guardRecoveryTestStore()
	empty := guardRecoveryTestLayer("profile-empty")
	store.layers = append(store.layers, empty)
	foreignKey := guardKey("another-app", "sublayer")
	foreignFilters := append([]guardRecoveryFilter(nil), store.filterByLayer[foreignKey]...)
	report, err := guardRecoverWithStore(store, true)
	if err != nil || report.FilterCount != 3 || report.RemovedFilters != 3 || report.RemovedProfiles != 3 || report.RemainingProfiles != 0 {
		t.Fatal("restore did not remove all own profiles", report, err)
	}
	if len(store.layers) != 1 || store.layers[0].key != foreignKey || !reflect.DeepEqual(store.filterByLayer[foreignKey], foreignFilters) {
		t.Fatal("restore changed foreign policy")
	}
	if store.active || store.calls[0] != "begin" || store.calls[len(store.calls)-1] != "commit" {
		t.Fatal("restore did not commit exactly one transaction", store.calls)
	}
	second, err := guardRecoverWithStore(store, true)
	if err != nil || second.RemovedFilters != 0 || second.RemovedProfiles != 0 || second.RemainingProfiles != 0 {
		t.Fatal("repeating recovery was not harmless", second, err)
	}
}

func TestGuardRecoveryForeignFilterCancelsWholeTransaction(t *testing.T) {
	store := guardRecoveryTestStore()
	key := guardKey("profile-b", "sublayer")
	store.filterByLayer[key] = append(store.filterByLayer[key], guardRecoveryFilter{key: guardKey("foreign", "filter"), name: "Foreign rule"})
	layers, filters := append([]guardRecoverySublayer(nil), store.layers...), guardRecoveryCopyFilters(store.filterByLayer)
	report, err := guardRecoverWithStore(store, true)
	if err == nil || !strings.Contains(err.Error(), "unrecognized filter") || report.RemovedFilters != 0 || report.RemovedProfiles != 0 {
		t.Fatal("foreign filter was not rejected", report, err)
	}
	if !reflect.DeepEqual(store.calls, []string{"begin", "abort"}) || !reflect.DeepEqual(store.layers, layers) || !reflect.DeepEqual(store.filterByLayer, filters) {
		t.Fatal("foreign filter caused policy changes", store.calls)
	}
}

func TestGuardRecoveryFailuresRollBackWithoutDeletingOtherPolicy(t *testing.T) {
	for _, failure := range []string{"begin", "enumerate", "filters", "filter-2", "sublayer", "commit"} {
		t.Run(failure, func(t *testing.T) {
			store := guardRecoveryTestStore()
			store.fail = failure
			layers, filters := append([]guardRecoverySublayer(nil), store.layers...), guardRecoveryCopyFilters(store.filterByLayer)
			report, err := guardRecoverWithStore(store, true)
			if err == nil || report.RemovedFilters != 0 || report.RemovedProfiles != 0 {
				t.Fatal("failure was reported as success", report, err)
			}
			if !reflect.DeepEqual(store.layers, layers) || !reflect.DeepEqual(store.filterByLayer, filters) || store.active {
				t.Fatal("failure did not restore original policy", store.calls)
			}
			if failure != "begin" && store.calls[len(store.calls)-1] != "abort" {
				t.Fatal("failed transaction was not aborted", store.calls)
			}
		})
	}
}

func TestGuardRecoveryFinalScanDetectsNewProfile(t *testing.T) {
	store := guardRecoveryTestStore()
	store.injectAfterCommit = true
	report, err := guardRecoverWithStore(store, true)
	if err == nil || report.RemovedProfiles != 2 || report.RemovedFilters != 3 || report.RemainingProfiles != 1 || store.active {
		t.Fatal("remaining profile was missed", report, err)
	}
	if store.calls[len(store.calls)-1] != "commit" {
		t.Fatal("committed policy was incorrectly aborted", store.calls)
	}
}
