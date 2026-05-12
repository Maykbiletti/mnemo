// Package tools is the dispatch registry for RPC calls coming over WSS.
//
// Each tool is a function (json.RawMessage) -> (any, error). The dispatcher
// routes by name. Stubs return a placeholder result; real cross-platform
// implementations follow as Mnemo Phase 2 fills in.
package tools

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

type Handler func(args json.RawMessage) (any, error)

var registry = map[string]Handler{
	"screenshot":  screenshot,
	"tap_at":      stub("tap_at"),
	"type_text":   stub("type_text"),
	"key_press":   stub("key_press"),
	"file_read":   fileRead,
	"file_write":  fileWrite,
	"shell_exec":  shellExec,
	"app_open":    stub("app_open"),
	"call_phone":  stub("call_phone"),
	"device_info": deviceInfo,
}

func Dispatch(method string, args json.RawMessage) (any, error) {
	h, ok := registry[method]
	if !ok {
		return nil, fmt.Errorf("unknown method: %s", method)
	}
	return h(args)
}

func stub(name string) Handler {
	return func(args json.RawMessage) (any, error) {
		return map[string]string{
			"status": "not_implemented",
			"tool":   name,
			"note":   "stub awaiting Phase 2 platform-specific implementation",
		}, nil
	}
}

// device_info — basic identity info, useful as round-trip smoke test
func deviceInfo(_ json.RawMessage) (any, error) {
	hn, _ := os.Hostname()
	wd, _ := os.Getwd()
	return map[string]any{
		"hostname":     hn,
		"os":           runtime.GOOS,
		"arch":         runtime.GOARCH,
		"go_version":   runtime.Version(),
		"working_dir":  wd,
		"server_time":  time.Now().UTC().Format(time.RFC3339Nano),
	}, nil
}

// screenshot — stubbed for now; real impl will use kbinani/screenshot
func screenshot(_ json.RawMessage) (any, error) {
	return map[string]any{
		"status":     "not_implemented",
		"tool":       "screenshot",
		"reason":     "platform binding pending",
		"workaround": "set device's PrintScreen → file location and use file_read",
	}, nil
}

type fileReadArgs struct {
	Path     string `json:"path"`
	Encoding string `json:"encoding,omitempty"` // utf8 (default) | base64
}

func fileRead(raw json.RawMessage) (any, error) {
	var a fileReadArgs
	if err := json.Unmarshal(raw, &a); err != nil {
		return nil, err
	}
	if a.Path == "" {
		return nil, fmt.Errorf("path required")
	}
	clean := filepath.Clean(a.Path)
	data, err := os.ReadFile(clean)
	if err != nil {
		return nil, err
	}
	if a.Encoding == "base64" {
		return map[string]any{"path": clean, "encoding": "base64", "content": encodeBase64(data), "bytes": len(data)}, nil
	}
	return map[string]any{"path": clean, "encoding": "utf8", "content": string(data), "bytes": len(data)}, nil
}

type fileWriteArgs struct {
	Path     string `json:"path"`
	Content  string `json:"content"`
	Encoding string `json:"encoding,omitempty"`
	Confirm  bool   `json:"confirm,omitempty"`
}

func fileWrite(raw json.RawMessage) (any, error) {
	var a fileWriteArgs
	if err := json.Unmarshal(raw, &a); err != nil {
		return nil, err
	}
	if a.Path == "" {
		return nil, fmt.Errorf("path required")
	}
	if !a.Confirm {
		return map[string]any{"status": "needs_confirmation", "path": a.Path, "bytes": len(a.Content),
			"note": "set confirm=true to actually write — this is a destructive op"}, nil
	}
	clean := filepath.Clean(a.Path)
	var data []byte
	if a.Encoding == "base64" {
		var err error
		data, err = decodeBase64(a.Content)
		if err != nil {
			return nil, err
		}
	} else {
		data = []byte(a.Content)
	}
	if err := os.WriteFile(clean, data, 0644); err != nil {
		return nil, err
	}
	return map[string]any{"status": "written", "path": clean, "bytes": len(data)}, nil
}

type shellExecArgs struct {
	Cmd        string `json:"cmd"`
	Cwd        string `json:"cwd,omitempty"`
	TimeoutSec int    `json:"timeout_sec,omitempty"`
	Confirm    bool   `json:"confirm,omitempty"`
}

func shellExec(raw json.RawMessage) (any, error) {
	var a shellExecArgs
	if err := json.Unmarshal(raw, &a); err != nil {
		return nil, err
	}
	if a.Cmd == "" {
		return nil, fmt.Errorf("cmd required")
	}
	if !a.Confirm {
		return map[string]any{"status": "needs_confirmation", "cmd": a.Cmd, "cwd": a.Cwd,
			"note": "set confirm=true to actually execute — this can run anything"}, nil
	}
	if a.TimeoutSec == 0 {
		a.TimeoutSec = 30
	}
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("cmd", "/C", a.Cmd)
	} else {
		cmd = exec.Command("sh", "-c", a.Cmd)
	}
	if a.Cwd != "" {
		cmd.Dir = a.Cwd
	}
	out, err := cmd.CombinedOutput()
	res := map[string]any{
		"cmd":         a.Cmd,
		"cwd":         a.Cwd,
		"exit":        cmd.ProcessState.ExitCode(),
		"stdout_size": len(out),
		"output":      string(out),
	}
	if err != nil {
		res["error"] = err.Error()
	}
	return res, nil
}
