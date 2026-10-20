package netcore

import (
	"bytes"
	"context"
	"io"
	"net"
	"testing"
	"time"
)

func TestProxyPreservesResponseAfterRequestHalfClose(t *testing.T) {
	backend, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { backend.Close() })
	payload := bytes.Repeat([]byte("response after EOF\x00"), 32*1024)
	backendDone := make(chan error, 1)
	go func() {
		connection, err := backend.Accept()
		if err != nil {
			backendDone <- err
			return
		}
		defer connection.Close()
		connection.SetDeadline(time.Now().Add(3 * time.Second))
		request, err := io.ReadAll(connection)
		if err == nil && string(request) != "request" {
			err = io.ErrUnexpectedEOF
		}
		if err == nil {
			// Ensure the proxy has observed request EOF before the response exists.
			time.Sleep(25 * time.Millisecond)
			_, err = connection.Write(payload)
		}
		backendDone <- err
	}()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := newProxy(listener, func(ctx context.Context) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp4", backend.Addr().String())
	})
	t.Cleanup(p.Close)
	connection, err := net.DialTimeout("tcp4", listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { connection.Close() })
	connection.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := connection.Write([]byte("request")); err != nil {
		t.Fatal(err)
	}
	if err := connection.(*net.TCPConn).CloseWrite(); err != nil {
		t.Fatal(err)
	}
	response, err := io.ReadAll(connection)
	if err != nil || !bytes.Equal(response, payload) {
		t.Fatalf("half-close truncated response: got %d of %d bytes, error %v", len(response), len(payload), err)
	}
	if err := <-backendDone; err != nil {
		t.Fatal(err)
	}
}

func TestProxyCountsSixteenClientsInsteadOfTheirSocketPairs(t *testing.T) {
	for _, test := range []struct {
		name   string
		limits []int
	}{
		{"omitted", nil},
		{"negative", []int{-1}},
		{"invalid finite limit", []int{4097}},
	} {
		t.Run(test.name, func(t *testing.T) { testProxySixteenClientLimit(t, test.limits...) })
	}
}

func testProxySixteenClientLimit(t *testing.T, limits ...int) {
	t.Helper()
	echo, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { echo.Close() })
	go func() {
		for {
			connection, err := echo.Accept()
			if err != nil {
				return
			}
			go func() { defer connection.Close(); io.Copy(connection, connection) }()
		}
	}()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := newProxy(listener, func(ctx context.Context) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp4", echo.Addr().String())
	}, limits...)
	t.Cleanup(p.Close)
	var connections []net.Conn
	t.Cleanup(func() {
		for _, connection := range connections {
			connection.Close()
		}
	})
	dial := func() net.Conn {
		t.Helper()
		connection, err := net.DialTimeout("tcp4", listener.Addr().String(), time.Second)
		if err != nil {
			t.Fatal(err)
		}
		connections = append(connections, connection)
		connection.SetDeadline(time.Now().Add(3 * time.Second))
		return connection
	}
	roundTrip := func(connection net.Conn) {
		t.Helper()
		if _, err := connection.Write([]byte{42}); err != nil {
			t.Fatal(err)
		}
		var result [1]byte
		if _, err := io.ReadFull(connection, result[:]); err != nil || result[0] != 42 {
			t.Fatalf("expected an opaque round trip, got %v / %v", result, err)
		}
	}
	for range 16 {
		roundTrip(dial())
	}
	// A full proxy rejects a seventeenth client without evicting the others.
	excess := dial()
	var result [1]byte
	if _, err := excess.Read(result[:]); err == nil {
		t.Fatal("seventeenth client was accepted")
	} else if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
		t.Fatal("seventeenth client was left hanging instead of rejected")
	}
	connections[0].Close()
	deadline := time.Now().Add(3 * time.Second)
	for {
		p.mu.Lock()
		count := p.clients
		p.mu.Unlock()
		if count == 15 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("closed client did not release its slot")
		}
		time.Sleep(10 * time.Millisecond)
	}
	roundTrip(dial())
	p.Close()
	for _, connection := range connections[1:] {
		connection.SetReadDeadline(time.Now().Add(time.Second))
		if _, err := connection.Read(result[:]); err == nil {
			t.Fatal("revoked proxy still carried data")
		} else if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
			t.Fatal("revocation did not close an established socket")
		}
	}
}

func TestProxyDataChannelCapacityDoesNotRetainTheModelClientLimit(t *testing.T) {
	for _, test := range []struct {
		name  string
		limit int
	}{
		{"explicit finite limit", 4096},
		{"explicit unlimited", 0},
	} {
		t.Run(test.name, func(t *testing.T) { testProxyConcurrentDataChannels(t, test.limit) })
	}
}

func testProxyConcurrentDataChannels(t *testing.T, limit int) {
	t.Helper()
	const clientCount = 600
	echo, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { echo.Close() })
	backendClosed := make(chan struct{}, clientCount)
	go func() {
		for {
			connection, err := echo.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() { connection.Close(); backendClosed <- struct{}{} }()
				io.Copy(connection, connection)
			}()
		}
	}()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := newProxy(listener, func(ctx context.Context) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp4", echo.Addr().String())
	}, limit)
	t.Cleanup(p.Close)
	var connections []net.Conn
	t.Cleanup(func() {
		for _, connection := range connections {
			connection.Close()
		}
	})
	roundTrip := func(connection net.Conn, index int) {
		t.Helper()
		connection.SetDeadline(time.Now().Add(3 * time.Second))
		payload := []byte{byte(index >> 8), byte(index)}
		if _, err := connection.Write(payload); err != nil {
			t.Fatalf("proxy data stream %d write failed: %v", index, err)
		}
		var reply [2]byte
		if _, err := io.ReadFull(connection, reply[:]); err != nil || !bytes.Equal(reply[:], payload) {
			t.Fatalf("proxy data stream %d failed: %v", index, err)
		}
	}
	for index := range clientCount {
		connection, err := net.DialTimeout("tcp4", listener.Addr().String(), time.Second)
		if err != nil {
			t.Fatal(err)
		}
		connections = append(connections, connection)
		roundTrip(connection, index)
	}
	// Keep every connection alive together; neither an explicit finite limit
	// nor unlimited admission may silently fall back to the default 16.
	p.mu.Lock()
	clients, sockets := p.clients, len(p.connections)
	p.mu.Unlock()
	if clients != clientCount || sockets != 2*clientCount {
		t.Fatalf("expected %d live clients and their socket pairs, got %d / %d", clientCount, clients, sockets)
	}
	for index, connection := range connections {
		roundTrip(connection, index)
	}
	p.Close()
	for _, connection := range connections {
		connection.SetReadDeadline(time.Now().Add(3 * time.Second))
		var reply [1]byte
		if _, err := connection.Read(reply[:]); err == nil {
			t.Fatal("revoked data proxy still carried a live connection")
		} else if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
			t.Fatal("revoked data proxy left a connection open")
		}
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		p.mu.Lock()
		clients, sockets = p.clients, len(p.connections)
		p.mu.Unlock()
		if clients == 0 && sockets == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("revoked data proxy retained %d clients / %d sockets", clients, sockets)
		}
		time.Sleep(10 * time.Millisecond)
	}
	backendDeadline := time.After(5 * time.Second)
	for range clientCount {
		select {
		case <-backendClosed:
		case <-backendDeadline:
			t.Fatal("revoked data proxy retained an echo backend connection")
		}
	}
	if connection, err := net.DialTimeout("tcp4", listener.Addr().String(), time.Second); err == nil {
		connection.Close()
		t.Fatal("revoked data proxy retained its listener")
	}
}

func TestRevokingProxyCancelsPendingDial(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	dialStarted := make(chan struct{})
	dialStopped := make(chan struct{})
	p := newProxy(listener, func(ctx context.Context) (net.Conn, error) {
		close(dialStarted)
		<-ctx.Done()
		close(dialStopped)
		return nil, ctx.Err()
	})
	t.Cleanup(p.Close)
	connection, err := net.DialTimeout("tcp4", listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { connection.Close() })
	select {
	case <-dialStarted:
	case <-time.After(time.Second):
		t.Fatal("proxy did not start its dial")
	}
	p.Close()
	select {
	case <-dialStopped:
	case <-time.After(time.Second):
		t.Fatal("revoked proxy kept an in-flight dial alive")
	}
}
