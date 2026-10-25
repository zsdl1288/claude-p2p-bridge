package netcore

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"time"
)

type request struct {
	ID     uint64          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}
type response struct {
	ID     uint64 `json:"id"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

// Private stdio RPC: no control port, auth keys, or login URLs on command lines.
func Run(input io.Reader, output io.Writer) error {
	return runWithManagerFactory(input, output, New)
}

// Factory injection is used by local test binaries, never by a production
// command line option or RPC parameter.
func runWithManagerFactory(input io.Reader, output io.Writer, create func(Config) (*Manager, error)) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	encoder := json.NewEncoder(output)
	var writeMu sync.Mutex
	write := func(r response) { writeMu.Lock(); defer writeMu.Unlock(); encoder.Encode(r) }
	var manager *Manager
	var pending sync.WaitGroup
	defer func() {
		cancel()
		if manager != nil {
			manager.Close()
		}
		pending.Wait()
	}()
	for scanner.Scan() {
		var req request
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			return err
		}
		if req.Method == "init" {
			if manager != nil {
				write(response{ID: req.ID, Error: "already initialized"})
				continue
			}
			var config Config
			err := json.Unmarshal(req.Params, &config)
			if err == nil {
				manager, err = create(config)
			}
			if err != nil {
				write(response{ID: req.ID, Error: err.Error()})
			} else {
				write(response{ID: req.ID, Result: map[string]bool{"ready": true}})
			}
			continue
		}
		if manager == nil {
			write(response{ID: req.ID, Error: "initialize network core first"})
			continue
		}
		pending.Add(1)
		go func(req request) {
			defer pending.Done()
			callCtx, stop := context.WithTimeout(ctx, 15*time.Second)
			defer stop()
			var result any
			var err error
			var params struct {
				Port           int    `json:"port"`
				TargetPort     int    `json:"targetPort"`
				Host           string `json:"host"`
				ID             string `json:"id"`
				Data           string `json:"data"`
				MaxConnections *int   `json:"maxConnections"`
				Type           string `json:"type"`
				Size           int    `json:"size"`
			}
			if len(req.Params) > 0 {
				err = json.Unmarshal(req.Params, &params)
			}
			if err == nil {
				var limits []int
				if params.MaxConnections != nil {
					limits = []int{*params.MaxConnections}
				}
				switch req.Method {
				case "status":
					result, err = manager.Status(callCtx)
				case "diagnostics":
					result, err = manager.Diagnostics(callCtx)
				case "native-proxy-configure":
					var config NativeProxyConfig
					if err = json.Unmarshal(req.Params, &config); err == nil {
						result, err = manager.NativeProxyConfigure(callCtx, config)
					}
				case "native-proxy-status":
					result = manager.NativeProxyStatus()
				case "native-speed-prepare", "native-speed-start":
					var reservation NativeSpeedRequest
					if err = json.Unmarshal(req.Params, &reservation); err == nil {
						if req.Method == "native-speed-prepare" {
							result, err = manager.NativeSpeedPrepare(callCtx, reservation)
						} else {
							result, err = manager.NativeSpeedStart(callCtx, reservation)
						}
					}
				case "native-speed-status":
					var query struct {
						ID    string `json:"id"`
						Renew bool   `json:"renew"`
					}
					if err = json.Unmarshal(req.Params, &query); err == nil {
						result, err = manager.NativeSpeedStatus(query.ID, query.Renew)
					}
				case "native-speed-cancel":
					var cancelRequest struct {
						Epoch  uint64 `json:"epoch"`
						ID     string `json:"id"`
						Reason string `json:"reason"`
					}
					if err = json.Unmarshal(req.Params, &cancelRequest); err == nil {
						result, err = manager.NativeSpeedCancel(cancelRequest.Epoch, cancelRequest.ID, cancelRequest.Reason)
					}
				case "native-proxy-close":
					var closeRequest struct {
						Epoch uint64 `json:"epoch"`
					}
					if err = json.Unmarshal(req.Params, &closeRequest); err == nil {
						result, err = manager.NativeProxyClose(closeRequest.Epoch)
					}
				case "channel-probe":
					result, err = manager.ChannelProbe(callCtx, params.Host, params.Type, params.Size)
				case "refresh-transport":
					// The operation is fixed. Reject options instead of exposing a
					// generic debug-action proxy over the private RPC interface.
					var fields map[string]json.RawMessage
					if err = json.Unmarshal(req.Params, &fields); err == nil && fields != nil && len(fields) == 0 {
						result = manager.RefreshTransport(callCtx)
					} else {
						err = errors.New("refresh-transport requires an empty object")
					}
				case "login":
					result, err = manager.Login(callCtx)
				case "connect":
					result, err = manager.Connect(callCtx)
				case "disconnect":
					result, err = manager.Disconnect(callCtx)
				case "protect", "unprotect":
					var input, output []byte
					input, err = base64.StdEncoding.DecodeString(params.Data)
					if err == nil {
						output, err = protectState(input, req.Method == "unprotect")
						clear(input)
					}
					if err == nil {
						result = map[string]string{"data": base64.StdEncoding.EncodeToString(output)}
						clear(output)
					}
				case "listen":
					result, err = manager.Listen(callCtx, params.Port, params.TargetPort, limits...)
				case "dial":
					result, err = manager.Dial(callCtx, params.Host, params.Port, limits...)
				case "release":
					manager.Release(params.ID)
					result = map[string]bool{"released": true}
				default:
					err = errors.New("unknown network method")
				}
			}
			if err != nil {
				write(response{ID: req.ID, Error: err.Error()})
			} else {
				write(response{ID: req.ID, Result: result})
			}
		}(req)
	}
	return scanner.Err()
}
