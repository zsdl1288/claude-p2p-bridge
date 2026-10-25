package netcore

import (
	"errors"
	"math"
	"net"
	"time"
)

const nativeSpeedRateCeiling = 125000000

var nativeSpeedRates = []uint64{125000, 250000, 625000, 1250000, 3125000, 6250000, 12500000, 25000000, 50000000, 87500000, 125000000}

type NativeSpeedUDPStage struct {
	NativeSpeedUDPTransfer
	Index                int      `json:"index"`
	TargetBytesPerSecond uint64   `json:"targetBytesPerSecond"`
	SenderDurationMs     *float64 `json:"senderDurationMs"`
	SenderBytesPerSecond *float64 `json:"senderBytesPerSecond"`
	TargetReached        bool     `json:"targetReached"`
	Assessment           string   `json:"assessment"`
}
type NativeSpeedUDPResult struct {
	Mode                      string                `json:"mode"`
	Completion                string                `json:"completion"`
	Stages                    []NativeSpeedUDPStage `json:"stages"`
	LowLossStageIndex         *int                  `json:"lowLossStageIndex"`
	PeakStageIndex            *int                  `json:"peakStageIndex"`
	StopReason                *string               `json:"stopReason"`
	LowerBound                bool                  `json:"lowerBound"`
	TotalSentBytes            uint64                `json:"totalSentBytes"`
	TotalReceivedBytes        uint64                `json:"totalReceivedBytes"`
	RateCeilingBytesPerSecond uint64                `json:"rateCeilingBytesPerSecond"`
	LossThresholdPercent      float64               `json:"lossThresholdPercent"`
	MinimumSenderRatio        float64               `json:"minimumSenderRatio"`
}

func nativeSpeedEmptyUDP() NativeSpeedUDPResult {
	return NativeSpeedUDPResult{Mode: "adaptive", Completion: "failed", Stages: []NativeSpeedUDPStage{}, RateCeilingBytesPerSecond: nativeSpeedRateCeiling, LossThresholdPercent: 1, MinimumSenderRatio: 0.85}
}
func nativeSpeedEmptyMetrics() NativeSpeedMetrics {
	m := NativeSpeedMetrics{Latency: NativeSpeedLatency{Samples: []float64{}}, Download: NativeSpeedTransfer{Completion: "failed"}, Upload: NativeSpeedTransfer{Completion: "failed"}}
	m.UDP.Download = nativeSpeedEmptyUDP()
	m.UDP.Upload = nativeSpeedEmptyUDP()
	m.TCPMulti = NativeSpeedTCPMulti{Mode: "adaptive", ConnectionCounts: append([]int{}, nativeSpeedConnectionCounts...), EarlyStop: NativeSpeedTCPEarlyStop{MinimumGainPercent: 5, ConsecutiveStages: 2}, Download: nativeSpeedEmptyTCPDirection(), Upload: nativeSpeedEmptyTCPDirection()}
	return m
}
func nativeSpeedStage(index int, target uint64, v NativeSpeedUDPTransfer, duration *float64) NativeSpeedUDPStage {
	s := NativeSpeedUDPStage{NativeSpeedUDPTransfer: v, Index: index, TargetBytesPerSecond: target, SenderDurationMs: duration, Assessment: "incomplete"}
	s.OfferedBytesPerSecond = target
	s.PacketBytes = nativeSpeedPacketBytes
	if duration != nil && *duration > 0 && v.SentBytes != nil {
		rate := float64(*v.SentBytes) * 1000 / *duration
		s.SenderBytesPerSecond = &rate
		s.TargetReached = rate >= float64(target)*0.85
	}
	if v.Completion == "complete" && v.LossPercent != nil && s.SenderBytesPerSecond != nil {
		switch {
		case !s.TargetReached:
			s.Assessment = "sender-limited"
		case *v.LossPercent > 1:
			s.Assessment = "loss-limited"
		default:
			s.Assessment = "passed"
		}
	}
	return s
}
func nativeSpeedSummarizeUDP(r *NativeSpeedUDPResult) {
	r.TotalSentBytes = 0
	r.TotalReceivedBytes = 0
	r.LowLossStageIndex = nil
	r.PeakStageIndex = nil
	for i, s := range r.Stages {
		r.TotalReceivedBytes += s.ReceivedBytes
		if s.SentBytes != nil {
			r.TotalSentBytes += *s.SentBytes
		}
		if s.Completion != "complete" || s.LossPercent == nil {
			continue
		}
		if r.PeakStageIndex == nil || s.BytesPerSecond > r.Stages[*r.PeakStageIndex].BytesPerSecond {
			n := i
			r.PeakStageIndex = &n
		}
		if *s.LossPercent <= 1 && (r.LowLossStageIndex == nil || s.BytesPerSecond > r.Stages[*r.LowLossStageIndex].BytesPerSecond) {
			n := i
			r.LowLossStageIndex = &n
		}
	}
}
func (j *nativeSpeedJob) udpResultTarget(name string) *NativeSpeedUDPResult {
	if name == "udp-download" {
		return &j.status.Metrics.UDP.Download
	}
	return &j.status.Metrics.UDP.Upload
}
func (j *nativeSpeedJob) udpStageResult(name string, stage NativeSpeedUDPStage) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.status.Finished {
		return
	}
	nativeSpeedPutUDPStage(j.udpResultTarget(name), stage)
}
func nativeSpeedPutUDPStage(r *NativeSpeedUDPResult, stage NativeSpeedUDPStage) {
	if stage.Index < 0 || stage.Index > 12 || stage.Index > len(r.Stages) {
		return
	}
	if stage.Index == len(r.Stages) {
		r.Stages = append(r.Stages, stage)
	} else {
		if r.Stages[stage.Index].Completion == "complete" && stage.Completion != "complete" {
			return
		}
		r.Stages[stage.Index] = stage
	}
	r.Completion = "partial"
	nativeSpeedSummarizeUDP(r)
}
func (j *nativeSpeedJob) udpFinished(name, reason string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.status.Finished {
		return
	}
	r := j.udpResultTarget(name)
	nativeSpeedFinishUDP(r, reason)
}
func nativeSpeedFinishUDP(r *NativeSpeedUDPResult, reason string) {
	r.StopReason = &reason
	r.LowerBound = reason == "sender-limited" || reason == "rate-ceiling" || reason == "byte-budget" || reason == "time-budget"
	nativeSpeedSummarizeUDP(r)
	r.Completion = "failed"
	if len(r.Stages) > 0 {
		r.Completion = "partial"
	}
	if r.PeakStageIndex != nil && reason != "cancelled" && reason != "failed" {
		r.Completion = "complete"
	}
}

// The controller advances only after an authenticated receiver report. Target
// rates are scheduling requests; capacity summaries always use actual delivery.
type nativeSpeedUDPPlan struct {
	rates       []uint64
	ladder      int
	low, high   uint64
	refinements int
	sent        uint64
	started     time.Time
	opts        nativeSpeedOptions
	reason      string
}

func newNativeSpeedUDPPlan(o nativeSpeedOptions) *nativeSpeedUDPPlan {
	return &nativeSpeedUDPPlan{rates: o.udpRates, started: time.Now(), opts: o}
}
func (p *nativeSpeedUDPPlan) next() (uint64, string) {
	return p.nextWithTime(true)
}
func (p *nativeSpeedUDPPlan) nextWithTime(checkTime bool) (uint64, string) {
	if p.reason != "" {
		return 0, p.reason
	}
	var rate uint64
	if p.high != 0 {
		if p.refinements >= 2 {
			return 0, "loss-limited"
		}
		rate = (p.low + p.high) / 2
		if rate == p.low || rate == p.high {
			return 0, "loss-limited"
		}
	} else {
		if p.ladder >= len(p.rates) {
			return 0, "rate-ceiling"
		}
		rate = p.rates[p.ladder]
	}
	if checkTime && time.Since(p.started)+p.opts.udpStageDuration+p.opts.drain > p.opts.udpDuration {
		// This is an admission budget, not a mid-frame cancellation deadline.
		// Registration/report confirmation can finish afterward, bounded by
		// the entire job's hard 210-second deadline and 5-second control lease.
		return 0, "time-budget"
	}
	required := uint64(math.Ceil(float64(rate)*p.opts.udpStageDuration.Seconds()/nativeSpeedPacketBytes)) * nativeSpeedPacketBytes
	if required > p.opts.udpBytes-p.sent {
		return 0, "byte-budget"
	}
	return rate, ""
}
func (p *nativeSpeedUDPPlan) record(s NativeSpeedUDPStage) {
	if s.SentBytes != nil {
		p.sent += *s.SentBytes
	}
	if s.Assessment == "sender-limited" {
		p.reason = "sender-limited"
		return
	}
	if p.high != 0 {
		p.refinements++
		if s.Assessment == "passed" {
			p.low = s.TargetBytesPerSecond
		} else {
			p.high = s.TargetBytesPerSecond
		}
		return
	}
	if s.Assessment == "loss-limited" {
		p.high = s.TargetBytesPerSecond
	} else {
		p.low = s.TargetBytesPerSecond
		p.ladder++
	}
}

func (j *nativeSpeedJob) hostUDPPhase(c net.Conn, name string) error {
	plan := newNativeSpeedUDPPlan(j.opts)
	for index := 0; index < 13; index++ {
		rate, reason := plan.next()
		if reason != "" {
			j.udpFinished(name, reason)
			return nativeSpeedWriteMessage(c, nativeSpeedMessage{Kind: "udp-finished", Phase: name, StopReason: reason})
		}
		if err := nativeSpeedWriteMessage(c, nativeSpeedMessage{Kind: "udp-next", Phase: name, StageIndex: index, TargetBytesPerSecond: rate}); err != nil {
			return err
		}
		j.udpStageResult(name, nativeSpeedStage(index, rate, NativeSpeedUDPTransfer{NativeSpeedTransfer: NativeSpeedTransfer{Completion: "partial"}}, nil))
		stage, err := j.hostUDPStage(c, name, index, rate, j.opts.udpBytes-plan.sent)
		if err != nil {
			return err
		}
		plan.record(stage)
	}
	j.udpFinished(name, "loss-limited")
	return nativeSpeedWriteMessage(c, nativeSpeedMessage{Kind: "udp-finished", Phase: name, StopReason: "loss-limited"})
}
func (j *nativeSpeedJob) clientUDPPhase(c net.Conn, name string) error {
	plan := newNativeSpeedUDPPlan(j.opts)
	for index := 0; index <= 13; index++ {
		next, err := nativeSpeedReadMessage(c)
		if err != nil {
			return err
		}
		if next.Kind == "udp-finished" && next.Phase == name {
			if !nativeSpeedUDPStopReason(next.StopReason) {
				return errors.New("invalid UDP completion")
			}
			_, expected := plan.nextWithTime(false)
			if next.StopReason != "time-budget" && next.StopReason != expected {
				return errors.New("unconfirmed UDP completion reason")
			}
			j.udpFinished(name, next.StopReason)
			return nil
		}
		// The host owns the direction's elapsed-time budget; independently
		// comparing wall clocks would reject its final legal stage at high RTT.
		rate, reason := plan.nextWithTime(false)
		if index == 13 || reason != "" || next.Kind != "udp-next" || next.Phase != name || next.StageIndex != index || next.TargetBytesPerSecond != rate {
			return errors.New("invalid UDP progression")
		}
		j.udpStageResult(name, nativeSpeedStage(index, rate, NativeSpeedUDPTransfer{NativeSpeedTransfer: NativeSpeedTransfer{Completion: "partial"}}, nil))
		stage, err := j.clientUDPStage(c, name, index, rate, j.opts.udpBytes-plan.sent)
		if err != nil {
			return err
		}
		plan.record(stage)
	}
	return errors.New("UDP stage limit")
}
func nativeSpeedUDPStopReason(reason string) bool {
	return reason == "loss-limited" || reason == "sender-limited" || reason == "rate-ceiling" || reason == "byte-budget" || reason == "time-budget"
}
