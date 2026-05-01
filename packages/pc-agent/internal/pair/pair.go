// Package pair handles the pairing handshake with a Mnemo dispatcher.
//
// Flow:
//  1. Owner runs `mnemo-pc pair --dispatcher https://… --code 123456`.
//  2. We POST {device_kind, os, device_name, fingerprint, pairing_code} to /pc/pair.
//  3. Dispatcher validates the code (single-use, 5-min TTL), returns
//     {device_id, jwt, ws_url}.
//  4. We persist that to ~/.mnemo-pc.json.
package pair

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

type Config struct {
	DeviceID   string `json:"device_id"`
	JWT        string `json:"jwt"`
	WSURL      string `json:"ws_url"`
	Dispatcher string `json:"dispatcher"`
	DeviceName string `json:"device_name"`
	OS         string `json:"os"`
	PairedAt   string `json:"paired_at"`
}

type pairRequest struct {
	DeviceKind  string `json:"device_kind"`
	OS          string `json:"os"`
	DeviceName  string `json:"device_name"`
	Fingerprint string `json:"fingerprint"`
	PairingCode string `json:"pairing_code"`
}

type pairResponse struct {
	DeviceID string `json:"device_id"`
	JWT      string `json:"jwt"`
	WSURL    string `json:"ws_url"`
	Error    string `json:"error,omitempty"`
}

func configPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return filepath.Join(home, ".mnemo-pc.json")
}

func newFingerprint() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func Pair(dispatcher, code, deviceName string) (*Config, error) {
	req := pairRequest{
		DeviceKind:  "pc",
		OS:          runtime.GOOS,
		DeviceName:  deviceName,
		Fingerprint: newFingerprint(),
		PairingCode: code,
	}
	body, _ := json.Marshal(req)

	resp, err := http.Post(dispatcher+"/pc/pair", "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("post: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("dispatcher returned %d: %s", resp.StatusCode, string(raw))
	}
	var pr pairResponse
	if err := json.Unmarshal(raw, &pr); err != nil {
		return nil, fmt.Errorf("decode response: %w (body: %s)", err, string(raw))
	}
	if pr.Error != "" {
		return nil, fmt.Errorf("dispatcher error: %s", pr.Error)
	}
	if pr.DeviceID == "" || pr.JWT == "" || pr.WSURL == "" {
		return nil, fmt.Errorf("dispatcher response missing fields (got %+v)", pr)
	}
	return &Config{
		DeviceID:   pr.DeviceID,
		JWT:        pr.JWT,
		WSURL:      pr.WSURL,
		Dispatcher: dispatcher,
		DeviceName: deviceName,
		OS:         runtime.GOOS,
		PairedAt:   time.Now().UTC().Format(time.RFC3339),
	}, nil
}

func Load() (*Config, error) {
	p := configPath()
	raw, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

func (c *Config) Save() error {
	raw, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(configPath(), raw, 0600)
}

func (c *Config) Path() string { return configPath() }
