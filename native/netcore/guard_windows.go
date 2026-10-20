//go:build windows

package netcore

import (
	"encoding/binary"
	"errors"
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Historical Windows x64 WFP ABI. Keep the complete SDK structure layouts even
// when recovery reads only identity fields; no installation API is retained.
type guardDisplay struct{ Name, Description *uint16 }
type guardBlob struct {
	Size uint32
	Data *byte
}
type guardValue struct {
	Type  uint32
	Value uintptr
}
type guardCondition struct {
	Key   windows.GUID
	Match uint32
	Value guardValue
}
type guardAction struct {
	Type uint32
	Key  windows.GUID
}
type guardFilter struct {
	Key             windows.GUID
	Display         guardDisplay
	Flags           uint32
	Provider        *windows.GUID
	Data            guardBlob
	Layer, Sublayer windows.GUID
	Weight          guardValue
	ConditionCount  uint32
	Conditions      *guardCondition
	Action          guardAction
	Context         [2]uint64
	Reserved        *windows.GUID
	ID              uint64
	EffectiveWeight guardValue
}
type guardSublayer struct {
	Key      windows.GUID
	Display  guardDisplay
	Flags    uint32
	Provider *windows.GUID
	Data     guardBlob
	Weight   uint16
}

var (
	guardWFP            = windows.NewLazySystemDLL("fwpuclnt.dll")
	guardEngineOpen     = guardWFP.NewProc("FwpmEngineOpen0")
	guardEngineClose    = guardWFP.NewProc("FwpmEngineClose0")
	guardBegin          = guardWFP.NewProc("FwpmTransactionBegin0")
	guardCommit         = guardWFP.NewProc("FwpmTransactionCommit0")
	guardAbort          = guardWFP.NewProc("FwpmTransactionAbort0")
	guardSublayerDelete = guardWFP.NewProc("FwpmSubLayerDeleteByKey0")
	guardFilterDelete   = guardWFP.NewProc("FwpmFilterDeleteByKey0")
	guardEnumCreate     = guardWFP.NewProc("FwpmFilterCreateEnumHandle0")
	guardEnum           = guardWFP.NewProc("FwpmFilterEnum0")
	guardEnumDestroy    = guardWFP.NewProc("FwpmFilterDestroyEnumHandle0")
	guardFree           = guardWFP.NewProc("FwpmFreeMemory0")
)

const (
	guardPersistent = 1
	guardDisabled   = 0x20 // Legacy recovery also recognizes disabled filters.
	guardIndexed    = 0x40 // Legacy filters may carry BFE's indexing flag.
)

func guardKey(profile, label string) windows.GUID {
	digest := guardDigest(profile, label)
	digest[6] = (digest[6] & 0x0f) | 0x50
	digest[8] = (digest[8] & 0x3f) | 0x80
	key := windows.GUID{Data1: binary.LittleEndian.Uint32(digest[0:4]), Data2: binary.LittleEndian.Uint16(digest[4:6]), Data3: binary.LittleEndian.Uint16(digest[6:8])}
	copy(key.Data4[:], digest[8:16])
	return key
}

func guardResult(code uintptr, operation string) error {
	if code == 0 {
		return nil
	}
	return fmt.Errorf("network guard %s failed (Windows/WFP 0x%08x)", operation, uint32(code))
}

func guardCall(proc *windows.LazyProc, operation string, args ...uintptr) error {
	code, _, _ := proc.Call(args...)
	return guardResult(code, operation)
}

func guardOpen() (windows.Handle, error) {
	var handle windows.Handle
	// RPC_C_AUTHN_WINNT=10; a nil session makes STATIC/persistent objects, not
	// dynamic objects removed automatically when this helper exits.
	err := guardCall(guardEngineOpen, "open filtering engine", 0, 10, 0, 0, uintptr(unsafe.Pointer(&handle)))
	return handle, err
}

func guardFreePointer(pointer unsafe.Pointer) {
	if pointer != nil {
		_, _, _ = guardFree.Call(uintptr(unsafe.Pointer(&pointer)))
	}
}

func guardBlobBytes(blob guardBlob) []byte {
	if blob.Size == 0 {
		return nil
	}
	if blob.Data == nil || blob.Size > 64*1024 {
		return nil
	}
	return unsafe.Slice(blob.Data, int(blob.Size))
}

func guardEnumerate(handle windows.Handle, sublayer windows.GUID, visit func(*guardFilter) error) error {
	var enum windows.Handle
	if err := guardCall(guardEnumCreate, "create filter enumeration", uintptr(handle), 0, uintptr(unsafe.Pointer(&enum))); err != nil {
		return err
	}
	defer guardEnumDestroy.Call(uintptr(handle), uintptr(enum))
	for {
		var entries **guardFilter
		var count uint32
		if err := guardCall(guardEnum, "enumerate protection filters", uintptr(handle), uintptr(enum), 256, uintptr(unsafe.Pointer(&entries)), uintptr(unsafe.Pointer(&count))); err != nil {
			return err
		}
		if count == 0 {
			guardFreePointer(unsafe.Pointer(entries))
			return nil
		}
		if count > 256 || entries == nil {
			guardFreePointer(unsafe.Pointer(entries))
			return errors.New("invalid WFP filter enumeration")
		}
		var err error
		for _, filter := range unsafe.Slice(entries, int(count)) {
			if filter != nil && filter.Sublayer == sublayer {
				if err = visit(filter); err != nil {
					break
				}
			}
		}
		guardFreePointer(unsafe.Pointer(entries))
		if err != nil {
			return err
		}
	}
}
