package netcore

import (
	"context"
	"errors"
	"math"
	"net"
)

const nativeSpeedMaxFlows = 20

var nativeSpeedConnectionCounts = []int{1, 2, 4, 8, 16}

type NativeSpeedTCPEarlyStop struct {
	MinimumGainPercent int `json:"minimumGainPercent"`
	ConsecutiveStages  int `json:"consecutiveStages"`
}

func nativeSpeedTCPConnections(n int) bool { return n == 1 || n == 2 || n == 4 || n == 8 || n == 16 }

type NativeSpeedTCPStage struct {
	NativeSpeedMultiTransfer
	Index       int `json:"index"`
	Connections int `json:"connections"`
}
type NativeSpeedTCPDirection struct {
	Completion         string                `json:"completion"`
	Stages             []NativeSpeedTCPStage `json:"stages"`
	BestStageIndex     *int                  `json:"bestStageIndex"`
	TotalReceivedBytes uint64                `json:"totalReceivedBytes"`
	StopReason         *string               `json:"stopReason"`
}

func nativeSpeedEmptyTCPDirection() NativeSpeedTCPDirection {
	return NativeSpeedTCPDirection{Completion: "failed", Stages: []NativeSpeedTCPStage{}}
}
func nativeSpeedSummarizeTCP(r *NativeSpeedTCPDirection) {
	r.TotalReceivedBytes = 0
	r.BestStageIndex = nil
	for i, s := range r.Stages {
		if s.DurationMs > 0 {
			s.BytesPerSecond = float64(s.ReceivedBytes) * 1000 / s.DurationMs
		} else {
			s.BytesPerSecond = 0
		}
		r.Stages[i].BytesPerSecond = s.BytesPerSecond
		r.TotalReceivedBytes += s.ReceivedBytes
		if s.Completion == "complete" && (r.BestStageIndex == nil || s.BytesPerSecond > r.Stages[*r.BestStageIndex].BytesPerSecond) {
			index := i
			r.BestStageIndex = &index
		}
	}
}
func nativeSpeedPutTCPStage(r *NativeSpeedTCPDirection, s NativeSpeedTCPStage) {
	if r.StopReason != nil || s.Index < 0 || s.Index >= len(nativeSpeedConnectionCounts) || s.Index > len(r.Stages) || nativeSpeedConnectionCounts[s.Index] != s.Connections || len(s.Streams) != s.Connections {
		return
	}
	if s.Index == len(r.Stages) {
		r.Stages = append(r.Stages, s)
	} else {
		if r.Stages[s.Index].Connections != s.Connections {
			return
		}
		nativeSpeedMergeMulti(&r.Stages[s.Index].NativeSpeedMultiTransfer, s.NativeSpeedMultiTransfer)
	}
	r.Completion = "partial"
	nativeSpeedSummarizeTCP(r)
}
func nativeSpeedFinishTCP(r *NativeSpeedTCPDirection, reason string) bool {
	if r.StopReason != nil {
		return *r.StopReason == reason
	}
	normal := reason == "completed" || reason == "plateau"
	if normal {
		_, expected, err := nativeSpeedTCPDecision(r.Stages)
		if err != nil || expected != reason {
			return false
		}
	}
	r.StopReason = &reason
	nativeSpeedSummarizeTCP(r)
	r.Completion = "failed"
	if len(r.Stages) > 0 {
		r.Completion = "partial"
	}
	if normal {
		r.Completion = "complete"
	}
	return true
}
func (j *nativeSpeedJob) putMultiResultLocked(p *nativeSpeedMultiPhase, v NativeSpeedMultiTransfer) {
	r := &j.status.Metrics.TCPMulti.Upload
	if p.name == "tcp-adaptive-download" {
		r = &j.status.Metrics.TCPMulti.Download
	}
	nativeSpeedPutTCPStage(r, NativeSpeedTCPStage{NativeSpeedMultiTransfer: v, Index: p.stageIndex, Connections: p.count})
	if p.stageIndex == 0 && len(r.Stages) > 0 {
		if p.name == "tcp-adaptive-download" {
			j.status.Metrics.Download = r.Stages[0].NativeSpeedTransfer
		} else {
			j.status.Metrics.Upload = r.Stages[0].NativeSpeedTransfer
		}
	}
}
func (j *nativeSpeedJob) tcpDirectionFinished(name, reason string) bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.status.Finished {
		return false
	}
	r := &j.status.Metrics.TCPMulti.Upload
	if name == "tcp-adaptive-download" {
		r = &j.status.Metrics.TCPMulti.Download
	}
	return nativeSpeedFinishTCP(r, reason)
}
func cloneNativeTCPDirection(r NativeSpeedTCPDirection) NativeSpeedTCPDirection {
	r.Stages = append([]NativeSpeedTCPStage{}, r.Stages...)
	for i := range r.Stages {
		r.Stages[i].Streams = append([]NativeSpeedTCPStream{}, r.Stages[i].Streams...)
	}
	return r
}
func (j *nativeSpeedJob) hostTCPDirection(c net.Conn, name string) error {
	for {
		stages, err := j.tcpStages(name)
		if err != nil {
			return err
		}
		index, reason, err := nativeSpeedTCPDecision(stages)
		if err != nil {
			return err
		}
		if reason != "" {
			if !j.tcpDirectionFinished(name, reason) {
				return context.Canceled
			}
			return nativeSpeedWriteMessage(c, nativeSpeedMessage{Kind: "tcp-finished", Phase: name, StopReason: reason, StageCount: len(stages)})
		}
		count := nativeSpeedConnectionCounts[index]
		if err = nativeSpeedWriteMessage(c, nativeSpeedMessage{Kind: "tcp-next", Phase: name, StageIndex: index, Connections: count}); err != nil {
			return err
		}
		if err = j.hostMultiPhase(c, name, index, count); err != nil {
			return err
		}
	}
}
func (j *nativeSpeedJob) clientTCPDirection(c net.Conn, name string) error {
	for {
		next, err := nativeSpeedReadMessage(c)
		if err != nil {
			return err
		}
		stages, err := j.tcpStages(name)
		if err != nil {
			return err
		}
		index, reason, err := nativeSpeedValidateTCPControl(next, name, stages)
		if err != nil {
			return err
		}
		if reason != "" {
			if !j.tcpDirectionFinished(name, reason) {
				return context.Canceled
			}
			return nil
		}
		if err = j.clientMultiPhase(c, name, index, nativeSpeedConnectionCounts[index]); err != nil {
			return err
		}
	}
}
func (j *nativeSpeedJob) tcpStages(name string) ([]NativeSpeedTCPStage, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.status.Finished {
		return nil, context.Canceled
	}
	r := j.status.Metrics.TCPMulti.Upload
	if name == "tcp-adaptive-download" {
		r = j.status.Metrics.TCPMulti.Download
	}
	return cloneNativeTCPDirection(r).Stages, nil
}

// Both peers replay exactly this expression using canonical receiver bytes and
// duration. Compare against the prior best before incorporating the new stage;
// two small improvements may still be a plateau even if each sets a new best.
func nativeSpeedTCPDecision(stages []NativeSpeedTCPStage) (int, string, error) {
	if len(stages) > len(nativeSpeedConnectionCounts) {
		return 0, "", errors.New("TCP stage limit")
	}
	best := 0.0
	weak := 0
	for i, s := range stages {
		if s.Index != i || s.Connections != nativeSpeedConnectionCounts[i] || len(s.Streams) != s.Connections || s.Completion != "complete" || s.DurationMs <= 0 || math.IsNaN(s.DurationMs) || math.IsInf(s.DurationMs, 0) {
			return 0, "", errors.New("unconfirmed TCP stage")
		}
		var total uint64
		for index, stream := range s.Streams {
			if stream.Index != index || stream.Completion != "complete" || stream.DurationMs <= 0 || stream.DurationMs > s.DurationMs || math.IsNaN(stream.DurationMs) || math.IsInf(stream.DurationMs, 0) {
				return 0, "", errors.New("unconfirmed TCP stream")
			}
			total += stream.ReceivedBytes
		}
		if total != s.ReceivedBytes {
			return 0, "", errors.New("TCP receiver total mismatch")
		}
		rate := float64(s.ReceivedBytes) * 1000 / s.DurationMs
		if best > 0 && rate*100 < best*105 {
			weak++
		} else {
			weak = 0
		}
		if rate > best {
			best = rate
		}
		if i == len(nativeSpeedConnectionCounts)-1 {
			return len(stages), "completed", nil
		}
		if weak >= 2 {
			if i+1 != len(stages) {
				return 0, "", errors.New("TCP continued after plateau")
			}
			return len(stages), "plateau", nil
		}
	}
	return len(stages), "", nil
}
func nativeSpeedValidateTCPControl(msg nativeSpeedMessage, name string, stages []NativeSpeedTCPStage) (int, string, error) {
	index, reason, err := nativeSpeedTCPDecision(stages)
	if err != nil {
		return 0, "", err
	}
	if msg.Phase != name {
		return 0, "", errors.New("TCP control phase mismatch")
	}
	if reason != "" {
		if msg.Kind != "tcp-finished" || msg.StopReason != reason || msg.StageCount != len(stages) {
			return 0, "", errors.New("TCP stop reason unconfirmed")
		}
		return index, reason, nil
	}
	if msg.Kind != "tcp-next" || msg.StageIndex != index || msg.Connections != nativeSpeedConnectionCounts[index] {
		return 0, "", errors.New("TCP next stage unconfirmed")
	}
	return index, "", nil
}
