package netcore

import (
	"encoding/binary"
	"errors"
	"io"
	"net/netip"
	"strings"
)

func nativeReadAuth(c io.ReadWriter) (string, string, error) {
	var head [2]byte
	if _, err := io.ReadFull(c, head[:]); err != nil {
		return "", "", err
	}
	if head[0] != 5 || head[1] == 0 {
		return "", "", errors.New("invalid SOCKS greeting")
	}
	methods := make([]byte, int(head[1]))
	if _, err := io.ReadFull(c, methods); err != nil {
		return "", "", err
	}
	found := false
	for _, m := range methods {
		found = found || m == 2
	}
	if !found {
		nativeWrite(c, []byte{5, 255})
		return "", "", errors.New("authentication required")
	}
	if err := nativeWrite(c, []byte{5, 2}); err != nil {
		return "", "", err
	}
	if _, err := io.ReadFull(c, head[:]); err != nil {
		return "", "", err
	}
	if head[0] != 1 || head[1] == 0 {
		return "", "", errors.New("invalid authentication")
	}
	u := make([]byte, int(head[1]))
	if _, err := io.ReadFull(c, u); err != nil {
		return "", "", err
	}
	var size [1]byte
	if _, err := io.ReadFull(c, size[:]); err != nil {
		return "", "", err
	}
	if size[0] == 0 {
		return "", "", errors.New("invalid authentication")
	}
	p := make([]byte, int(size[0]))
	if _, err := io.ReadFull(c, p); err != nil {
		return "", "", err
	}
	return string(u), string(p), nil
}
func nativeSendAuth(c io.ReadWriter, u, p string) error {
	if len(u) < 1 || len(u) > 255 || len(p) < 1 || len(p) > 255 {
		return errors.New("invalid credentials")
	}
	if err := nativeWrite(c, []byte{5, 1, 2}); err != nil {
		return err
	}
	var response [2]byte
	if _, err := io.ReadFull(c, response[:]); err != nil {
		return err
	}
	if response != [2]byte{5, 2} {
		return errors.New("SOCKS authentication unsupported")
	}
	packet := append([]byte{1, byte(len(u))}, []byte(u)...)
	packet = append(packet, byte(len(p)))
	packet = append(packet, []byte(p)...)
	if err := nativeWrite(c, packet); err != nil {
		return err
	}
	if _, err := io.ReadFull(c, response[:]); err != nil {
		return err
	}
	if response != [2]byte{1, 0} {
		return errors.New("SOCKS authentication rejected")
	}
	return nil
}
func nativeAddress(host string, port int) ([]byte, error) {
	if port < 0 || port > 65535 {
		return nil, errors.New("invalid port")
	}
	var out []byte
	if a, err := netip.ParseAddr(host); err == nil && a.Zone() == "" {
		if a.Is4() {
			out = append([]byte{1}, a.AsSlice()...)
		} else {
			out = append([]byte{4}, a.AsSlice()...)
		}
	} else {
		if len(host) == 0 || len(host) > 253 || strings.ContainsAny(host, "\x00%/\\ \r\n\t") {
			return nil, errors.New("invalid hostname")
		}
		out = append([]byte{3, byte(len(host))}, []byte(host)...)
	}
	return append(out, byte(port>>8), byte(port)), nil
}
func nativeReadAddress(r io.Reader) (string, int, error) {
	var kind [1]byte
	if _, err := io.ReadFull(r, kind[:]); err != nil {
		return "", 0, err
	}
	var size int
	switch kind[0] {
	case 1:
		size = 4
	case 4:
		size = 16
	case 3:
		var b [1]byte
		if _, err := io.ReadFull(r, b[:]); err != nil {
			return "", 0, err
		}
		size = int(b[0])
		if size == 0 || size > 253 {
			return "", 0, errors.New("invalid hostname")
		}
	default:
		return "", 0, errors.New("invalid address type")
	}
	address := make([]byte, size)
	if _, err := io.ReadFull(r, address); err != nil {
		return "", 0, err
	}
	var port [2]byte
	if _, err := io.ReadFull(r, port[:]); err != nil {
		return "", 0, err
	}
	var host string
	if kind[0] == 3 {
		host = string(address)
		if strings.ContainsAny(host, "\x00%/\\ \r\n\t") {
			return "", 0, errors.New("invalid hostname")
		}
	} else {
		a, ok := netip.AddrFromSlice(address)
		if !ok {
			return "", 0, errors.New("invalid address")
		}
		host = a.String()
	}
	return host, int(binary.BigEndian.Uint16(port[:])), nil
}
func nativeReadRequest(r io.Reader) (byte, string, int, error) {
	var head [3]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		return 0, "", 0, err
	}
	if head[0] != 5 || head[2] != 0 {
		return 0, "", 0, errors.New("invalid SOCKS request")
	}
	host, port, err := nativeReadAddress(r)
	return head[1], host, port, err
}
func nativeSendRequest(w io.Writer, command byte, host string, port int) error {
	address, err := nativeAddress(host, port)
	if err != nil {
		return err
	}
	return nativeWrite(w, append([]byte{5, command, 0}, address...))
}
func nativeReply(w io.Writer, code byte, host string, port int) error {
	return nativeSendRequest(w, code, host, port)
}
func nativeReadReply(r io.Reader) (byte, string, int, error) { return nativeReadRequest(r) }
