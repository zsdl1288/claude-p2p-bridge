package netcore

import (
	"reflect"
	"testing"
)

func nativeSpeedTestTCPStage(index int, bytes uint64) NativeSpeedTCPStage {
	count := nativeSpeedConnectionCounts[index]
	v := nativeSpeedEmptyMulti(count)
	v.ReceivedBytes = bytes
	v.DurationMs = 1000
	v.BytesPerSecond = float64(bytes)
	v.Completion = "complete"
	remaining := bytes
	for i := range v.Streams {
		n := bytes / uint64(count)
		if i == count-1 {
			n = remaining
		}
		remaining -= n
		v.Streams[i] = NativeSpeedTCPStream{Index: i, ReceivedBytes: n, DurationMs: 1000, Completion: "complete"}
	}
	return NativeSpeedTCPStage{NativeSpeedMultiTransfer: v, Index: index, Connections: count}
}

func TestNativeSpeedTCPAdaptiveKeepsAllStagesAndLowerCountTie(t *testing.T) {
	r := nativeSpeedEmptyTCPDirection()
	for i, bytes := range []uint64{1600, 800, 3200, 1600, 3200} {
		nativeSpeedPutTCPStage(&r, nativeSpeedTestTCPStage(i, bytes))
	}
	nativeSpeedFinishTCP(&r, "completed")
	if len(r.Stages) != 5 || r.Completion != "complete" || r.BestStageIndex == nil || *r.BestStageIndex != 2 || r.Stages[*r.BestStageIndex].Connections != 4 || r.TotalReceivedBytes != 10400 {
		t.Fatalf("lost slower stages or selected higher count on a tie: %+v", r)
	}
	before := cloneNativeTCPDirection(r)
	late := nativeSpeedTestTCPStage(0, 9999)
	nativeSpeedPutTCPStage(&r, late)
	if !reflect.DeepEqual(before, r) {
		t.Fatal("late stage changed completed direction")
	}
}

func TestNativeSpeedTCPAdaptiveCancelHistoryAndIndependentSnapshot(t *testing.T) {
	j := newNativeSpeedJob(nativeSpeedTestRequest(), "client", nativeTestBackend{}, nativeSpeedOptions{})
	defer j.finish("closed", false)
	first := j.newMulti("tcp-adaptive-download", "first-stage", 0, 1)
	initial := nativeSpeedTestTCPStage(0, 1600)
	j.multiResult(first, initial.NativeSpeedMultiTransfer)
	active := j.newMulti("tcp-adaptive-download", "second-stage", 1, 2)
	if !j.activateMulti(active) {
		t.Fatal("activate")
	}
	active.start()
	active.mu.Lock()
	active.received = 300
	active.streams[0].ReceivedBytes = 100
	active.streams[1].ReceivedBytes = 200
	active.mu.Unlock()
	j.multiResult(active, active.result(false))
	snapshot := j.snapshot(false)
	snapshot.Metrics.TCPMulti.ConnectionCounts[0] = 32
	snapshot.Metrics.TCPMulti.Download.Stages[0].Streams[0].ReceivedBytes = 9999
	fresh := j.snapshot(false)
	if fresh.Metrics.TCPMulti.ConnectionCounts[0] != 1 || fresh.Metrics.TCPMulti.Download.Stages[0].Streams[0].ReceivedBytes != 1600 {
		t.Fatal("snapshot aliases live adaptive streams")
	}
	j.finish("user-cancelled", false)
	final := j.snapshot(false)
	r := final.Metrics.TCPMulti.Download
	if r.Completion != "partial" || len(r.Stages) != 2 || r.TotalReceivedBytes != 1900 || r.BestStageIndex == nil || *r.BestStageIndex != 0 || r.Stages[1].Completion != "partial" || r.Stages[1].ReceivedBytes != 300 || *r.StopReason != "cancelled" {
		t.Fatalf("cancel lost confirmed history or promoted partial: %+v", r)
	}
	if !reflect.DeepEqual(final.Metrics.Download, r.Stages[0].NativeSpeedTransfer) {
		t.Fatal("baseline lost its confirmed first-stage value")
	}
}
