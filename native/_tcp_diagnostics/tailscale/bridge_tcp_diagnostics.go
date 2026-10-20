// Copyright (c) Claude Bridge contributors.
// SPDX-License-Identifier: MIT

package netstack

import "gvisor.dev/gvisor/pkg/tcpip/transport/tcp"

// BridgeTCPEndpoints is installed only in an audited local diagnostics build.
// It returns handles, never addresses or payloads. 129 permits the caller to
// report truncation while processing at most 128 endpoints.
func (ns *Impl) BridgeTCPEndpoints(limit int) []any {
	result := []any{}
	if ns == nil || ns.ipstack == nil || limit <= 0 {
		return result
	}
	if limit > 129 {
		limit = 129
	}
	// RegisteredEndpoints releases all stack/demux locks before returning.
	endpoints := ns.ipstack.RegisteredEndpoints()
	seen := make(map[*tcp.Endpoint]bool)
	for _, endpoint := range endpoints {
		if ep, ok := endpoint.(*tcp.Endpoint); ok && !seen[ep] {
			seen[ep] = true
			result = append(result, ep)
			if len(result) == limit {
				break
			}
		}
	}
	return result
}
