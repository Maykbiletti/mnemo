// Package ws maintains the long-lived WSS connection to the dispatcher,
// reads frames, dispatches to tools, and returns results.
package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"runtime"
	"time"

	"github.com/Maykbiletti/mnemo/packages/pc-agent/internal/pair"
	"github.com/Maykbiletti/mnemo/packages/pc-agent/internal/tools"

	"nhooyr.io/websocket"
)

type Frame struct {
	V       int             `json:"v"`
	ID      string          `json:"id,omitempty"`
	TS      string          `json:"ts"`
	Kind    string          `json:"kind"`
	Method  string          `json:"method,omitempty"`
	Args    json.RawMessage `json:"args,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *FrameError     `json:"error,omitempty"`
	Event   string          `json:"event,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type FrameError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

const heartbeatInterval = 25 * time.Second

func Run(cfg *pair.Config) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	for {
		err := connectAndServe(ctx, cfg)
		if err != nil {
			log.Printf("ws disconnect: %v — reconnecting in 5s", err)
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(5 * time.Second):
			}
			continue
		}
		return nil
	}
}

func connectAndServe(ctx context.Context, cfg *pair.Config) error {
	headers := map[string][]string{
		"Authorization": {"Bearer " + cfg.JWT},
		"User-Agent":    {fmt.Sprintf("mnemo-pc/%s (%s/%s)", "0.1.0-dev", runtime.GOOS, runtime.GOARCH)},
	}
	c, _, err := websocket.Dial(ctx, cfg.WSURL, &websocket.DialOptions{HTTPHeader: headers})
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer c.Close(websocket.StatusNormalClosure, "shutdown")
	log.Printf("[mnemo-pc] connected to %s as %s", cfg.WSURL, cfg.DeviceID)

	// Heartbeat goroutine
	hbCtx, hbCancel := context.WithCancel(ctx)
	defer hbCancel()
	go func() {
		ticker := time.NewTicker(heartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-hbCtx.Done():
				return
			case <-ticker.C:
				if err := writeFrame(ctx, c, &Frame{Kind: "heartbeat", TS: time.Now().UTC().Format(time.RFC3339Nano)}); err != nil {
					log.Printf("[mnemo-pc] heartbeat failed: %v", err)
					return
				}
			}
		}
	}()

	for {
		_, raw, err := c.Read(ctx)
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}
		var f Frame
		if err := json.Unmarshal(raw, &f); err != nil {
			log.Printf("[mnemo-pc] bad frame: %v", err)
			continue
		}
		if f.Kind == "heartbeat" {
			continue
		}
		if f.Kind == "rpc.request" {
			go handleRPC(ctx, c, f)
		}
	}
}

func writeFrame(ctx context.Context, c *websocket.Conn, f *Frame) error {
	if f.V == 0 {
		f.V = 1
	}
	if f.TS == "" {
		f.TS = time.Now().UTC().Format(time.RFC3339Nano)
	}
	raw, err := json.Marshal(f)
	if err != nil {
		return err
	}
	return c.Write(ctx, websocket.MessageText, raw)
}

func handleRPC(ctx context.Context, c *websocket.Conn, req Frame) {
	resp := Frame{ID: req.ID, Kind: "rpc.response"}
	out, err := tools.Dispatch(req.Method, req.Args)
	if err != nil {
		resp.Kind = "rpc.error"
		resp.Error = &FrameError{Code: -32000, Message: err.Error()}
	} else {
		resp.Result, _ = json.Marshal(out)
	}
	if err := writeFrame(ctx, c, &resp); err != nil {
		log.Printf("[mnemo-pc] write response failed: %v", err)
	}
}

// helpful for debugging — print env on start
func init() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.Printf("[mnemo-pc] starting on %s/%s pid=%d", runtime.GOOS, runtime.GOARCH, os.Getpid())
}
