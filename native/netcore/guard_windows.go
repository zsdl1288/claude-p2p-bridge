//go:build windows

package netcore

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Windows SDK ABI, x64 only. No callout driver, dynamic session or global
// firewall policy changes are involved. See Microsoft FWPM_FILTER0 and filter
// arbitration documentation. Persistent filters intentionally have NO provider:
// a provider without an auto-start service can have its filters disabled by BFE.
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
type guardV4Mask struct{ Address, Mask uint32 }
type guardV6Mask struct {
	Address      [16]byte
	PrefixLength uint8
}

var (
	guardWFP            = windows.NewLazySystemDLL("fwpuclnt.dll")
	guardEngineOpen     = guardWFP.NewProc("FwpmEngineOpen0")
	guardEngineClose    = guardWFP.NewProc("FwpmEngineClose0")
	guardBegin          = guardWFP.NewProc("FwpmTransactionBegin0")
	guardCommit         = guardWFP.NewProc("FwpmTransactionCommit0")
	guardAbort          = guardWFP.NewProc("FwpmTransactionAbort0")
	guardSublayerAdd    = guardWFP.NewProc("FwpmSubLayerAdd0")
	guardSublayerGet    = guardWFP.NewProc("FwpmSubLayerGetByKey0")
	guardSublayerDelete = guardWFP.NewProc("FwpmSubLayerDeleteByKey0")
	guardFilterAdd      = guardWFP.NewProc("FwpmFilterAdd0")
	guardFilterDelete   = guardWFP.NewProc("FwpmFilterDeleteByKey0")
	guardEnumCreate     = guardWFP.NewProc("FwpmFilterCreateEnumHandle0")
	guardEnum           = guardWFP.NewProc("FwpmFilterEnum0")
	guardEnumDestroy    = guardWFP.NewProc("FwpmFilterDestroyEnumHandle0")
	guardAppID          = guardWFP.NewProc("FwpmGetAppIdFromFileName0")
	guardFree           = guardWFP.NewProc("FwpmFreeMemory0")
	guardShellExecute   = windows.NewLazySystemDLL("shell32.dll").NewProc("ShellExecuteExW")
	guardConnect4       = guardParseGUID("c38d57d1-05a7-4c33-904f-7fbceee60e82")
	guardConnect6       = guardParseGUID("4a72393b-319f-44bc-84c3-ba54dcb3b6b4")
	guardReceive4       = guardParseGUID("e1cd9fe7-f4b5-4273-96c0-592e487b8650")
	guardReceive6       = guardParseGUID("a3b42c97-9f04-4672-b87e-cee9c483257f")
	guardCondApp        = guardParseGUID("d78e1e87-8644-4ea5-9437-d809ecefc971")
	guardCondFlags      = guardParseGUID("632ce23b-5167-435c-86d7-e903684aa80c")
	guardCondRemote     = guardParseGUID("b235ae9a-1d64-49b8-a44c-5ff3d9095045")
	guardCondRemotePort = guardParseGUID("c35a604d-d22b-4e1a-91b4-68f674ee674b")
	guardCondInterface  = guardParseGUID("4cd62a49-59c3-4969-b7f3-bda5d32890a4")
	guardCondProtocol   = guardParseGUID("3971ef2b-623e-4f9a-8cb1-6e79b806b9a7")
	guardCondLocalPort  = guardParseGUID("0c1ba1af-5765-453f-af22-a8f791ac775b")
)

const (
	guardPersistent    = 1
	guardDisabled      = 0x20
	guardBlock         = 0x1001
	guardPermit        = 0x1002
	guardByteBlob      = 12
	guardUint8         = 1
	guardUint16        = 2
	guardUint32        = 3
	guardUint64        = 4
	guardV4AddressMask = 0x100
	guardV6AddressMask = 0x101
	guardFWPNotFound   = 0x80320007 // FWP_E_SUBLAYER_NOT_FOUND
	guardTunName       = "ClaudeBridgeTun"
)

func guardParseGUID(value string) windows.GUID {
	guid, err := windows.GUIDFromString("{" + value + "}")
	if err != nil {
		panic(err)
	}
	return guid
}

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

func guardCurrentHelper() (string, error) {
	if unsafe.Sizeof(uintptr(0)) != 8 {
		return "", errors.New("network guard requires Windows x64")
	}
	filename, err := os.Executable()
	if err != nil {
		return "", err
	}
	filename, err = filepath.EvalSymlinks(filename)
	if err != nil {
		return "", err
	}
	filename, err = filepath.Abs(filename)
	if err != nil {
		return "", err
	}
	base := filepath.Base(filename)
	if !strings.EqualFold(base, "bridge-net.exe") && !strings.EqualFold(base, "bridge-engine.exe") {
		return "", errors.New("network guard can only authorize its own bridge-net.exe or bridge-engine.exe executable")
	}
	return filepath.Clean(filename), nil
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

func guardReadAppID(filename string) (*guardBlob, error) {
	path, err := windows.UTF16PtrFromString(filename)
	if err != nil {
		return nil, err
	}
	var blob *guardBlob
	err = guardCall(guardAppID, "read helper application ID", uintptr(unsafe.Pointer(path)), uintptr(unsafe.Pointer(&blob)))
	return blob, err
}

func guardLayer(rule guardRule) windows.GUID {
	if rule.inbound {
		if rule.family == 4 {
			return guardReceive4
		}
		return guardReceive6
	}
	if rule.family == 4 {
		return guardConnect4
	}
	return guardConnect6
}

// backing owns Go allocations referred to by the raw Windows union pointers.
type guardBuiltFilter struct {
	filter  guardFilter
	backing []any
}

func guardBuildFilter(profile, helperPath string, rule guardRule, appID *guardBlob, tunLUID uint64) guardBuiltFilter {
	name, _ := windows.UTF16PtrFromString("Claude Bridge network protection " + rule.id)
	description, _ := windows.UTF16PtrFromString("Persistent until explicitly disabled; permits only bridge-net, loopback and LAN; business DNS is blocked outside loopback.")
	signature := guardRuleSignature(profile, strings.ToLower(helperPath), rule)
	weight := new(uint64)
	*weight = rule.weight
	conditions := []guardCondition{}
	backing := []any{name, description, signature, weight}
	if rule.self {
		conditions = append(conditions, guardCondition{Key: guardCondApp, Value: guardValue{Type: guardByteBlob, Value: uintptr(unsafe.Pointer(appID))}})
	}
	if rule.loopback {
		conditions = append(conditions, guardCondition{Key: guardCondFlags, Match: 6, Value: guardValue{Type: guardUint32, Value: 1}})
	}
	if rule.tun {
		luid := new(uint64)
		*luid = tunLUID
		conditions = append(conditions, guardCondition{Key: guardCondInterface, Value: guardValue{Type: guardUint64, Value: uintptr(unsafe.Pointer(luid))}})
		backing = append(backing, luid)
	}
	if rule.dnsPort != 0 {
		conditions = append(conditions, guardCondition{Key: guardCondRemotePort, Value: guardValue{Type: guardUint16, Value: uintptr(rule.dnsPort)}})
	}
	if rule.ndpType != 0 {
		conditions = append(conditions,
			guardCondition{Key: guardCondProtocol, Value: guardValue{Type: guardUint8, Value: 58}},
			guardCondition{Key: guardCondLocalPort, Value: guardValue{Type: guardUint16, Value: uintptr(rule.ndpType)}},
			guardCondition{Key: guardCondRemotePort, Value: guardValue{Type: guardUint16, Value: 0}})
	}
	if rule.prefix.IsValid() {
		if rule.family == 4 {
			address := rule.prefix.Addr().As4()
			mask := &guardV4Mask{Address: binary.BigEndian.Uint32(address[:]), Mask: ^uint32(0) << (32 - rule.prefix.Bits())}
			conditions = append(conditions, guardCondition{Key: guardCondRemote, Value: guardValue{Type: guardV4AddressMask, Value: uintptr(unsafe.Pointer(mask))}})
			backing = append(backing, mask)
		} else {
			mask := &guardV6Mask{Address: rule.prefix.Addr().As16(), PrefixLength: uint8(rule.prefix.Bits())}
			conditions = append(conditions, guardCondition{Key: guardCondRemote, Value: guardValue{Type: guardV6AddressMask, Value: uintptr(unsafe.Pointer(mask))}})
			backing = append(backing, mask)
		}
	}
	action := uint32(guardBlock)
	if rule.permit {
		action = guardPermit
	}
	filter := guardFilter{Key: guardKey(profile, rule.id), Display: guardDisplay{Name: name, Description: description}, Flags: guardPersistent,
		Data: guardBlob{Size: uint32(len(signature)), Data: &signature[0]}, Layer: guardLayer(rule), Sublayer: guardKey(profile, "sublayer"),
		Weight: guardValue{Type: guardUint64, Value: uintptr(unsafe.Pointer(weight))}, ConditionCount: uint32(len(conditions)), Action: guardAction{Type: action}}
	if len(conditions) != 0 {
		filter.Conditions = &conditions[0]
	}
	backing = append(backing, conditions)
	return guardBuiltFilter{filter: filter, backing: backing}
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

func guardEqualCondition(actual, expected guardCondition) bool {
	if actual.Key != expected.Key || actual.Match != expected.Match || actual.Value.Type != expected.Value.Type {
		return false
	}
	if actual.Value.Value == 0 || expected.Value.Value == 0 {
		return actual.Value.Value == expected.Value.Value
	}
	switch actual.Value.Type {
	case guardByteBlob:
		return bytes.Equal(guardBlobBytes(*(*guardBlob)(unsafe.Pointer(actual.Value.Value))), guardBlobBytes(*(*guardBlob)(unsafe.Pointer(expected.Value.Value))))
	case guardV4AddressMask:
		return *(*guardV4Mask)(unsafe.Pointer(actual.Value.Value)) == *(*guardV4Mask)(unsafe.Pointer(expected.Value.Value))
	case guardV6AddressMask:
		return *(*guardV6Mask)(unsafe.Pointer(actual.Value.Value)) == *(*guardV6Mask)(unsafe.Pointer(expected.Value.Value))
	case guardUint64:
		return *(*uint64)(unsafe.Pointer(actual.Value.Value)) == *(*uint64)(unsafe.Pointer(expected.Value.Value))
	default:
		return actual.Value.Value == expected.Value.Value
	}
}

func guardEqualFilter(actual, expected *guardFilter) bool {
	if actual.Key != expected.Key || actual.Sublayer != expected.Sublayer || actual.Layer != expected.Layer || actual.Provider != nil ||
		actual.Flags != guardPersistent || actual.Action.Type != expected.Action.Type || actual.ConditionCount != expected.ConditionCount ||
		actual.Weight.Type != guardUint64 || actual.Weight.Value == 0 ||
		*(*uint64)(unsafe.Pointer(actual.Weight.Value)) != *(*uint64)(unsafe.Pointer(expected.Weight.Value)) ||
		!bytes.Equal(guardBlobBytes(actual.Data), guardBlobBytes(expected.Data)) {
		return false
	}
	if actual.ConditionCount == 0 {
		return true
	}
	if actual.Conditions == nil || actual.ConditionCount > 16 {
		return false
	}
	conditions := unsafe.Slice(actual.Conditions, int(actual.ConditionCount))
	expectedConditions := unsafe.Slice(expected.Conditions, int(expected.ConditionCount))
	for i := range conditions {
		if !guardEqualCondition(conditions[i], expectedConditions[i]) {
			return false
		}
	}
	return true
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

// Match the fixed adapter name from our generated Clash profile. Interface type
// 53 is IANA propVirtual (Wintun), not an Ethernet/Wi-Fi adapter. No arbitrary
// adapter name or LUID can be supplied through the elevated command line.
func guardFindTun() (uint64, error) {
	size := uint32(15000)
	for attempt := 0; attempt < 4; attempt++ {
		if size == 0 || size > 1024*1024 {
			return 0, errors.New("invalid network adapter enumeration size")
		}
		buffer := make([]byte, size)
		first := (*windows.IpAdapterAddresses)(unsafe.Pointer(&buffer[0]))
		err := windows.GetAdaptersAddresses(windows.AF_UNSPEC, windows.GAA_FLAG_INCLUDE_ALL_INTERFACES, 0, first, &size)
		if err == windows.ERROR_BUFFER_OVERFLOW {
			continue
		}
		if err != nil {
			return 0, err
		}
		var match uint64
		for adapter := first; adapter != nil; adapter = adapter.Next {
			if !strings.EqualFold(windows.UTF16PtrToString(adapter.FriendlyName), guardTunName) {
				continue
			}
			if adapter.IfType != 53 || adapter.PhysicalAddressLength != 0 || adapter.Luid == 0 || adapter.OperStatus != windows.IfOperStatusUp {
				return 0, errors.New("ClaudeBridgeTun must be an active Wintun virtual interface")
			}
			if match != 0 {
				return 0, errors.New("more than one ClaudeBridgeTun interface was found")
			}
			match = adapter.Luid
		}
		runtime.KeepAlive(buffer)
		return match, nil
	}
	return 0, errors.New("network adapter list changed repeatedly")
}

func guardStoredTun(handle windows.Handle, profile string) (uint64, error) {
	var luid uint64
	var invalid bool
	keys := map[windows.GUID]bool{}
	for _, rule := range guardRules() {
		if rule.tun {
			keys[guardKey(profile, rule.id)] = true
		}
	}
	err := guardEnumerate(handle, guardKey(profile, "sublayer"), func(filter *guardFilter) error {
		if !keys[filter.Key] {
			return nil
		}
		if filter.ConditionCount != 1 || filter.Conditions == nil {
			invalid = true
			return nil
		}
		condition := *filter.Conditions
		if condition.Key != guardCondInterface || condition.Match != 0 || condition.Value.Type != guardUint64 || condition.Value.Value == 0 {
			invalid = true
			return nil
		}
		value := *(*uint64)(unsafe.Pointer(condition.Value.Value))
		if value == 0 || (luid != 0 && luid != value) {
			invalid = true
			return nil
		}
		luid = value
		return nil
	})
	if invalid {
		luid = 0
	}
	return luid, err
}

func guardStatus(handle windows.Handle, profile, helperPath string, appID *guardBlob) (NetworkGuardStatus, error) {
	status := NetworkGuardStatus{Supported: true, ProfileID: profile, State: "disabled", Scope: "windows-bfe-runtime", HelperPath: helperPath, AllowLAN: true, ExpectedFilters: len(guardRules()), TunName: guardTunName}
	tunLUID, err := guardStoredTun(handle, profile)
	if err != nil {
		status.State = "unknown"
		return status, err
	}
	currentTun, tunErr := guardFindTun()
	status.TunReady = tunErr == nil && currentTun != 0 && currentTun == tunLUID
	if tunLUID != 0 {
		status.TunLUID = strconv.FormatUint(tunLUID, 10)
	}
	expected := make(map[windows.GUID]guardBuiltFilter)
	for _, rule := range guardRules() {
		built := guardBuildFilter(profile, helperPath, rule, appID, tunLUID)
		expected[built.filter.Key] = built
	}
	matched := 0
	err = guardEnumerate(handle, guardKey(profile, "sublayer"), func(actual *guardFilter) error {
		status.FilterCount++
		built, ok := expected[actual.Key]
		if ok && guardEqualFilter(actual, &built.filter) {
			matched++
		} else {
			status.Issues = append(status.Issues, "missing, disabled, changed or obsolete filter: "+actual.Key.String())
		}
		return nil
	})
	runtime.KeepAlive(expected)
	if err != nil {
		status.State = "unknown"
		return status, err
	}
	if status.FilterCount == 0 {
		status.TunReady = tunErr == nil && currentTun != 0
		return status, nil
	}
	status.State = "partial"
	key := guardKey(profile, "sublayer")
	var layer *guardSublayer
	err = guardCall(guardSublayerGet, "inspect protection sublayer", uintptr(handle), uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(&layer)))
	if err != nil {
		return status, err
	}
	defer guardFreePointer(unsafe.Pointer(layer))
	if layer == nil || layer.Flags != guardPersistent || layer.Weight != 0xffff || layer.Provider != nil {
		status.Issues = append(status.Issues, "protection sublayer configuration does not match")
	} else if matched == status.ExpectedFilters && status.FilterCount == status.ExpectedFilters {
		status.State = "enabled"
		status.Enabled = true
	}
	if matched != status.ExpectedFilters {
		status.Issues = append(status.Issues, fmt.Sprintf("verified %d of %d required filters", matched, status.ExpectedFilters))
	}
	if !status.TunReady {
		status.Issues = append(status.Issues, "protected TUN is unavailable or was recreated; public traffic stays blocked, enable protection again after restoring ClaudeBridgeTun")
	}
	return status, nil
}

func guardApply(handle windows.Handle, profile, helperPath string, appID *guardBlob, enable bool) error {
	var tunLUID uint64
	if enable {
		var err error
		tunLUID, err = guardFindTun()
		if err != nil {
			return err
		}
		if tunLUID == 0 {
			return errors.New("start Clash TUN with device ClaudeBridgeTun before enabling protection")
		}
	}
	if err := guardCall(guardBegin, "begin policy transaction", uintptr(handle), 0); err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_, _, _ = guardAbort.Call(uintptr(handle))
		}
	}()
	key := guardKey(profile, "sublayer")
	var existing *guardSublayer
	code, _, _ := guardSublayerGet.Call(uintptr(handle), uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(&existing)))
	if code != 0 && uint32(code) != guardFWPNotFound {
		return guardResult(code, "inspect protection sublayer")
	}
	if existing != nil {
		valid := existing.Flags == guardPersistent && existing.Weight == 0xffff && existing.Provider == nil
		guardFreePointer(unsafe.Pointer(existing))
		if !valid {
			return errors.New("protection sublayer has unexpected ownership or configuration")
		}
		var keys []windows.GUID
		if err := guardEnumerate(handle, key, func(filter *guardFilter) error { keys = append(keys, filter.Key); return nil }); err != nil {
			return err
		}
		for _, filterKey := range keys {
			if err := guardCall(guardFilterDelete, "remove protection filter", uintptr(handle), uintptr(unsafe.Pointer(&filterKey))); err != nil {
				return err
			}
		}
	} else if enable {
		name, _ := windows.UTF16PtrFromString("Claude Bridge persistent network protection " + profile)
		layer := guardSublayer{Key: key, Display: guardDisplay{Name: name}, Flags: guardPersistent, Weight: 0xffff}
		if err := guardCall(guardSublayerAdd, "create protection sublayer", uintptr(handle), uintptr(unsafe.Pointer(&layer)), 0); err != nil {
			return err
		}
		runtime.KeepAlive(name)
	}
	if enable {
		for _, rule := range guardRules() {
			built := guardBuildFilter(profile, helperPath, rule, appID, tunLUID)
			err := guardCall(guardFilterAdd, "install protection filter "+rule.id, uintptr(handle), uintptr(unsafe.Pointer(&built.filter)), 0, 0)
			runtime.KeepAlive(built)
			if err != nil {
				return err
			}
		}
	} else if existing != nil {
		if err := guardCall(guardSublayerDelete, "remove protection sublayer", uintptr(handle), uintptr(unsafe.Pointer(&key))); err != nil {
			return err
		}
	}
	if err := guardCall(guardCommit, "commit protection policy", uintptr(handle)); err != nil {
		return err
	}
	committed = true
	return nil
}

type guardShellInfo struct {
	Size, Mask                        uint32
	Window                            windows.Handle
	Verb, File, Parameters, Directory *uint16
	Show                              int32
	Instance                          windows.Handle
	IDList                            uintptr
	Class                             *uint16
	ClassKey                          windows.Handle
	HotKey                            uint32
	Icon                              windows.Handle
	Process                           windows.Handle
}

func guardElevatedParameters(action, profile string) (string, error) {
	args, err := guardCLIArguments(action, profile)
	if err != nil {
		return "", err
	}
	if action != "enable" && action != "disable" && action != "status" {
		return "", errors.New("invalid administrator network guard action")
	}
	// All tokens are fixed literals or the validated [a-z0-9-] profile; no shell
	// expansion, user-supplied executable, paths, PowerShell or cmd are involved.
	return strings.Join(args, " "), nil
}

func guardReplyName(nonce string) (string, error) {
	if !guardReplyPattern.MatchString(nonce) {
		return "", errors.New("invalid network protection reply identifier")
	}
	return `\\.\pipe\ClaudeBridgeGuard-` + nonce, nil
}

type guardReplyFile struct{ *os.File }

func (reply guardReplyFile) Close() error {
	// Keep the client connected until its verified parent consumes the result.
	// A closed parent handle makes this fail promptly with a broken pipe.
	_ = windows.FlushFileBuffers(windows.Handle(reply.Fd()))
	return reply.File.Close()
}

func guardOpenReply(nonce string) (io.WriteCloser, error) {
	name, err := guardReplyName(nonce)
	if err != nil {
		return nil, err
	}
	pipeName, _ := windows.UTF16PtrFromString(name)
	handle, err := windows.CreateFile(pipeName, windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		return nil, err
	}
	valid := false
	defer func() {
		if !valid {
			windows.CloseHandle(handle)
		}
	}()
	var serverPID uint32
	if err := windows.GetNamedPipeServerProcessId(handle, &serverPID); err != nil {
		return nil, err
	}
	server, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, serverPID)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(server)
	buffer := make([]uint16, 32768)
	size := uint32(len(buffer))
	if err := windows.QueryFullProcessImageName(server, 0, &buffer[0], &size); err != nil {
		return nil, err
	}
	serverPath, err := filepath.EvalSymlinks(windows.UTF16ToString(buffer[:size]))
	if err != nil {
		return nil, err
	}
	helperPath, err := guardCurrentHelper()
	if err != nil {
		return nil, err
	}
	if !strings.EqualFold(filepath.Clean(serverPath), helperPath) {
		return nil, errors.New("network protection reply server is not this helper")
	}
	valid = true
	return guardReplyFile{os.NewFile(uintptr(handle), name)}, nil
}

func guardCreateReplyPipe() (windows.Handle, string, error) {
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return 0, "", err
	}
	nonce := hex.EncodeToString(random)
	name, _ := guardReplyName(nonce)
	pipeName, _ := windows.UTF16PtrFromString(name)
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return 0, "", err
	}
	descriptor, err := windows.SecurityDescriptorFromString("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;" + user.User.Sid.String() + ")")
	if err != nil {
		return 0, "", err
	}
	attributes := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: descriptor}
	handle, err := windows.CreateNamedPipe(pipeName, windows.PIPE_ACCESS_INBOUND|windows.FILE_FLAG_FIRST_PIPE_INSTANCE,
		windows.PIPE_TYPE_MESSAGE|windows.PIPE_READMODE_MESSAGE|windows.PIPE_NOWAIT|windows.PIPE_REJECT_REMOTE_CLIENTS, 1, 0, 64*1024, 0, &attributes)
	runtime.KeepAlive(descriptor)
	return handle, nonce, err
}

func guardWaitClient(pipe, process windows.Handle) (uint32, error) {
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		var pid uint32
		if err := windows.GetNamedPipeClientProcessId(pipe, &pid); err == nil {
			return pid, nil
		}
		wait, err := windows.WaitForSingleObject(process, 0)
		if err != nil {
			return 0, err
		}
		if wait == windows.WAIT_OBJECT_0 {
			return 0, errors.New("administrator helper exited without a protection response")
		}
		time.Sleep(20 * time.Millisecond)
	}
	return 0, errors.New("administrator protection response timed out; check status before retrying")
}

func guardDecodeReply(data []byte, profile string) (NetworkGuardStatus, error) {
	var envelope struct {
		NetworkGuardStatus
		Error  string             `json:"error"`
		Status NetworkGuardStatus `json:"status"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return NetworkGuardStatus{}, errors.New("invalid administrator network protection response")
	}
	if envelope.Error != "" {
		return envelope.Status, errors.New(envelope.Error)
	}
	status := envelope.NetworkGuardStatus
	if status.ProfileID != profile {
		return status, errors.New("administrator response profile mismatch")
	}
	if !status.Supported || (status.State != "enabled" && status.State != "disabled" && status.State != "partial") || status.Enabled != (status.State == "enabled") {
		return status, errors.New("administrator returned an inconsistent protection state")
	}
	if status.ExpectedFilters != len(guardRules()) || status.FilterCount < 0 || (status.Enabled && status.FilterCount != status.ExpectedFilters) || (status.State == "disabled" && status.FilterCount != 0) {
		return status, errors.New("administrator returned an incomplete protection rule count")
	}
	return status, nil
}

func guardElevate(action, profile, helperPath string) (NetworkGuardStatus, error) {
	var status NetworkGuardStatus
	parameters, err := guardElevatedParameters(action, profile)
	if err != nil {
		return status, err
	}
	pipe, nonce, err := guardCreateReplyPipe()
	if err != nil {
		return status, err
	}
	defer windows.CloseHandle(pipe)
	connectErr := windows.ConnectNamedPipe(pipe, nil)
	if connectErr != nil && connectErr != windows.ERROR_PIPE_LISTENING && connectErr != windows.ERROR_PIPE_CONNECTED {
		return status, connectErr
	}
	parameters += " --guard-reply " + nonce
	verb, _ := windows.UTF16PtrFromString("runas")
	file, err := windows.UTF16PtrFromString(helperPath)
	if err != nil {
		return status, err
	}
	params, _ := windows.UTF16PtrFromString(parameters)
	directory, _ := windows.UTF16PtrFromString(filepath.Dir(helperPath))
	info := guardShellInfo{Mask: 0x40 | 0x100 | 0x400, Verb: verb, File: file, Parameters: params, Directory: directory, Show: 0}
	info.Size = uint32(unsafe.Sizeof(info))
	ok, _, callErr := guardShellExecute.Call(uintptr(unsafe.Pointer(&info)))
	runtime.KeepAlive(info)
	if ok == 0 {
		return status, fmt.Errorf("network protection administrator authorization failed or was cancelled: %w", callErr)
	}
	if info.Process == 0 {
		return status, errors.New("administrator helper did not return a process handle")
	}
	defer windows.CloseHandle(info.Process)
	clientPID, err := guardWaitClient(pipe, info.Process)
	if err != nil {
		return status, err
	}
	processPID, err := windows.GetProcessId(info.Process)
	if err != nil {
		return status, err
	}
	if clientPID != processPID {
		return status, errors.New("administrator response came from an unexpected process")
	}
	buffer := make([]byte, 64*1024)
	var done uint32
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		err = windows.ReadFile(pipe, buffer, &done, nil)
		if err != windows.ERROR_NO_DATA {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil {
		return status, err
	}
	status, err = guardDecodeReply(buffer[:done], profile)
	if err != nil {
		return status, err
	}
	wait, err := windows.WaitForSingleObject(info.Process, 10000)
	if err != nil {
		return status, err
	}
	if wait != windows.WAIT_OBJECT_0 {
		return status, errors.New("administrator helper did not exit after its response")
	}
	var exit uint32
	if err := windows.GetExitCodeProcess(info.Process, &exit); err != nil {
		return status, err
	}
	if exit != 0 {
		return status, fmt.Errorf("administrator helper failed with exit code %d; check protection status", exit)
	}
	return status, nil
}

func runNetworkGuard(action, profile string) (NetworkGuardStatus, error) {
	status := NetworkGuardStatus{Supported: true, ProfileID: profile, State: "unknown", Scope: "windows-bfe-runtime"}
	if err := validateGuardProfile(profile); err != nil {
		return status, err
	}
	helperPath, err := guardCurrentHelper()
	if err != nil {
		return status, err
	}
	if action == "elevate-enable" || action == "elevate-disable" || action == "elevate-status" {
		return guardElevate(strings.TrimPrefix(action, "elevate-"), profile, helperPath)
	}
	handle, err := guardOpen()
	if err != nil {
		return status, err
	}
	defer guardEngineClose.Call(uintptr(handle))
	appID, err := guardReadAppID(helperPath)
	if err != nil {
		return status, err
	}
	defer guardFreePointer(unsafe.Pointer(appID))
	if action == "enable" || action == "disable" {
		if !windows.GetCurrentProcessToken().IsElevated() {
			return status, errors.New("administrator authorization is required to change network protection")
		}
		if err := guardApply(handle, profile, helperPath, appID, action == "enable"); err != nil {
			return status, err
		}
	}
	status, err = guardStatus(handle, profile, helperPath, appID)
	return status, err
}
