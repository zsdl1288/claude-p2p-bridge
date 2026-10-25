package netcore

import (
	"context"
	"errors"
	"net"
	"testing"
)

func nativeSpeedPlateauStages(rates ...uint64) []NativeSpeedTCPStage {
	stages := make([]NativeSpeedTCPStage, len(rates))
	for i, rate := range rates {
		stages[i] = nativeSpeedTestTCPStage(i, rate)
	}
	return stages
}

func TestNativeSpeedTCPPlateauThresholdAndReset(t *testing.T) {
	cases := []struct {
		name   string
		rates  []uint64
		reason string
	}{
		{"4.999 percent", []uint64{100000, 104999, 104999}, "plateau"},
		{"exact 5 percent", []uint64{100000, 105000, 105000}, ""},
		{"5.001 percent", []uint64{100000, 105001, 105001}, ""},
		{"two small new bests", []uint64{100000, 104000, 108160}, "plateau"},
		{"meaningful gain resets", []uint64{100000, 104000, 120000, 120000}, ""},
		{"zero reference ignored", []uint64{0, 0, 100000, 100000}, ""},
		{"last stage wins", []uint64{100000, 104000, 120000, 120000, 120000}, "completed"},
		{"declining", []uint64{100000, 90000, 80000}, "plateau"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stages := nativeSpeedPlateauStages(tc.rates...)
			for i := range stages {
				stages[i].BytesPerSecond = 999999999
			}
			index, reason, err := nativeSpeedTCPDecision(stages)
			if err != nil || index != len(stages) || reason != tc.reason {
				t.Fatalf("decision %d %q %v", index, reason, err)
			}
		})
	}
	r := nativeSpeedEmptyTCPDirection()
	for _, s := range nativeSpeedPlateauStages(100000, 104000, 108160) {
		nativeSpeedPutTCPStage(&r, s)
	}
	if !nativeSpeedFinishTCP(&r, "plateau") || r.Completion != "complete" || r.BestStageIndex == nil || *r.BestStageIndex != 2 || r.Stages[2].BytesPerSecond != 108160 {
		t.Fatal("plateau reference replaced the actual best")
	}
}

func TestNativeSpeedTCPPlateauControlEvidence(t *testing.T) {
	name := "tcp-adaptive-download"
	stages := nativeSpeedPlateauStages(100000, 100000, 100000)
	valid := nativeSpeedMessage{Kind: "tcp-finished", Phase: name, StopReason: "plateau", StageCount: 3}
	if _, reason, err := nativeSpeedValidateTCPControl(valid, name, stages); err != nil || reason != "plateau" {
		t.Fatal("valid stop rejected")
	}
	invalid := []nativeSpeedMessage{{Kind: "tcp-finished", Phase: name, StopReason: "completed", StageCount: 3}, {Kind: "tcp-finished", Phase: name, StopReason: "plateau", StageCount: 2}, {Kind: "tcp-finished", Phase: "tcp-adaptive-upload", StopReason: "plateau", StageCount: 3}, {Kind: "tcp-next", Phase: name, StageIndex: 3, Connections: 8}}
	for _, msg := range invalid {
		if _, _, err := nativeSpeedValidateTCPControl(msg, name, stages); err == nil {
			t.Fatalf("unconfirmed stop/continuation accepted: %+v", msg)
		}
	}
	if _, _, err := nativeSpeedTCPDecision(append(stages, nativeSpeedTestTCPStage(3, 999999))); err == nil {
		t.Fatal("continued beyond first plateau")
	}
	short := nativeSpeedPlateauStages(100000, 120000)
	if _, _, err := nativeSpeedValidateTCPControl(valid, name, short); err == nil {
		t.Fatal("two stages invented plateau")
	}
	next := nativeSpeedMessage{Kind: "tcp-next", Phase: name, StageIndex: 2, Connections: 4}
	if index, reason, err := nativeSpeedValidateTCPControl(next, name, short); err != nil || reason != "" || index != 2 {
		t.Fatal("confirmed next stage rejected")
	}
	stages[2].Completion = "partial"
	r := NativeSpeedTCPDirection{Completion: "partial", Stages: stages}
	if nativeSpeedFinishTCP(&r, "plateau") || r.StopReason != nil {
		t.Fatal("partial stage counted toward plateau")
	}
}

func TestNativeSpeedTCPPlateauWireCompletionAndLateCancel(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		name := "normal"
		if cancelled {
			name = "cancelled"
		}
		t.Run(name, func(t *testing.T) {
			host := newNativeSpeedJob(nativeSpeedTestRequest(), "host", nativeTestBackend{}, nativeSpeedOptions{})
			client := newNativeSpeedJob(nativeSpeedTestRequest(), "client", nativeTestBackend{}, nativeSpeedOptions{})
			defer host.finish("closed", false)
			defer client.finish("closed", false)
			for _, j := range []*nativeSpeedJob{host, client} {
				for _, stage := range nativeSpeedPlateauStages(100000, 104000, 108160) {
					nativeSpeedPutTCPStage(&j.status.Metrics.TCPMulti.Download, stage)
				}
			}
			if cancelled {
				client.finish("user-cancelled", false)
			}
			a, b := net.Pipe()
			defer a.Close()
			defer b.Close()
			done := make(chan error, 1)
			go func() { done <- host.hostTCPDirection(a, "tcp-adaptive-download") }()
			err := client.clientTCPDirection(b, "tcp-adaptive-download")
			hostErr := <-done
			if hostErr != nil {
				t.Fatal(hostErr)
			}
			r := client.snapshot(false).Metrics.TCPMulti.Download
			if cancelled {
				if !errors.Is(err, context.Canceled) || r.Completion != "partial" || r.StopReason == nil || *r.StopReason != "cancelled" {
					t.Fatalf("late framed finish overwrote cancellation: %+v %v", r, err)
				}
			} else {
				if err != nil || r.Completion != "complete" || r.StopReason == nil || *r.StopReason != "plateau" || len(r.Stages) != 3 || host.multi != nil || client.multi != nil {
					t.Fatalf("plateau wire did not finish without another data group: %+v %v", r, err)
				}
			}
		})
	}
}
