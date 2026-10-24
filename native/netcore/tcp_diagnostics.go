package netcore

import (
	"context"
	"errors"
	"reflect"
)

const tcpDiagnosticFlowLimit = 128

type TCPDiagnostics struct {
	Available bool                 `json:"available"`
	Flows     []TCPFlowDiagnostics `json:"flows"`
	Truncated bool                 `json:"truncated"`
	Limit     int                  `json:"limit"`
}

type TCPFlowDiagnostics struct {
	// This namespace is independent of JavaScript proxy flow IDs. The
	// netstack also carries control/model traffic; equal numbers cannot be
	// used to join records from those different namespaces.
	FlowID    uint64            `json:"flowId"`
	Available bool              `json:"available"`
	Metrics   map[string]uint64 `json:"metrics"`
	Message   string            `json:"message,omitempty"`
}

// Held only by a Manager under startMu. Keys are comparable weak identities,
// never endpoint pointers: they cannot keep an endpoint or its buffers alive.
// Replace the map on each successful snapshot to drop unselected identities.
type tcpFlowIDs struct {
	ids  map[any]uint64
	next uint64
}

var tcpDiagnosticMetricNames = [...]string{
	"state", "ccState", "sendWindowBytes", "zeroWindowProbing",
	"sendBufferUsedBytes", "sendBufferSizeBytes", "receiveBufferUsedBytes",
	"outstandingPackets", "inFlightSequenceBytes", "cwndPackets",
	"sackedOutNegative", "sackedOutAbsPackets",
	"srttNs", "rttVarNs", "rttValid", "rtoNs", "reorderSeen",
	"reorderWindowNs", "reorderWindowMultiplier", "reorderPersistNegative", "reorderPersistAbs",
	"segmentsSent", "segmentsReceived", "retransmits", "fastRetransmits", "timeouts",
	"localZeroWindowAdvertisements", "localReceiveBufferOverflows", "localSegmentQueueDrops",
}

func (s *tcpFlowIDs) snapshot(ctx context.Context, subsystem any) (*TCPDiagnostics, error) {
	provider, ok := subsystem.(interface{ BridgeTCPEndpoints(int) []any })
	if !ok {
		// Normal builds do not contain the shadow extensions or a tcp field.
		s.ids = nil
		return nil, nil
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	endpoints := provider.BridgeTCPEndpoints(tcpDiagnosticFlowLimit + 1)
	result := &TCPDiagnostics{Available: true, Flows: []TCPFlowDiagnostics{}, Limit: tcpDiagnosticFlowLimit}
	if len(endpoints) > tcpDiagnosticFlowLimit {
		result.Truncated = true
		endpoints = endpoints[:tcpDiagnosticFlowLimit]
	}
	current := make(map[any]uint64, len(endpoints))
	for _, endpoint := range endpoints {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		identity := reflect.ValueOf(endpoint)
		if !identity.IsValid() || identity.Kind() != reflect.Pointer || identity.IsNil() || !identity.Type().Comparable() {
			return nil, errors.New("embedded TCP diagnostic endpoint identity unsupported")
		}
		reader, ok := endpoint.(interface {
			BridgeTCPIdentity() any
			BridgeTCPDiagnostics() map[string]uint64
		})
		if !ok {
			return nil, errors.New("embedded TCP diagnostic endpoint unsupported")
		}
		key := reader.BridgeTCPIdentity()
		keyValue := reflect.ValueOf(key)
		if !keyValue.IsValid() || !keyValue.Type().Comparable() ||
			((keyValue.Kind() == reflect.Pointer || keyValue.Kind() == reflect.Interface) && keyValue.IsNil()) {
			return nil, errors.New("embedded TCP diagnostic weak identity unsupported")
		}
		if _, duplicate := current[key]; duplicate {
			continue
		}
		// No observer mutex is held while the endpoint takes its own locks.
		values := reader.BridgeTCPDiagnostics()
		available, present := values["available"]
		state, hasState := values["state"]
		if !present || available > 1 || !hasState {
			return nil, errors.New("embedded TCP diagnostic snapshot invalid")
		}
		flow := TCPFlowDiagnostics{Available: available == 1, Metrics: map[string]uint64{"state": state}}
		if flow.Available {
			for _, name := range tcpDiagnosticMetricNames {
				value, found := values[name]
				if !found {
					return nil, errors.New("embedded TCP diagnostic metric missing")
				}
				flow.Metrics[name] = value
			}
			for _, name := range [...]string{"zeroWindowProbing", "rttValid", "reorderSeen", "sackedOutNegative", "reorderPersistNegative"} {
				if flow.Metrics[name] > 1 {
					return nil, errors.New("embedded TCP diagnostic flag invalid")
				}
			}
		} else {
			flow.Message = "endpoint has no active TCP sender"
		}
		id, found := s.ids[key]
		if !found {
			s.next++
			id = s.next
		}
		current[key] = id
		flow.FlowID = id
		result.Flows = append(result.Flows, flow)
	}
	s.ids = current
	return result, nil
}
