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
	})
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
	}, 32)
	t.Cleanup(p.Close)
	for index := range 24 {
		connection, err := net.DialTimeout("tcp4", listener.Addr().String(), time.Second)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { connection.Close() })
		connection.SetDeadline(time.Now().Add(3 * time.Second))
		if _, err := connection.Write([]byte{byte(index)}); err != nil {
			t.Fatal(err)
		}
		var reply [1]byte
		if _, err := io.ReadFull(connection, reply[:]); err != nil || reply[0] != byte(index) {
			t.Fatalf("proxy data stream %d failed: %v", index, err)
		}
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
