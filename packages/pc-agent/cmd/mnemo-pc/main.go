// mnemo-pc — single-file PC agent. Connects out to a Mnemo dispatcher,
// executes RPC calls, returns results. Win/Mac/Linux.
//
// Build:    go build -ldflags "-s -w" -o mnemo-pc ./cmd/mnemo-pc
// Cross:    GOOS=windows GOARCH=amd64 go build -o mnemo-pc.exe ./cmd/mnemo-pc
// Pair:     mnemo-pc pair --code 123456 --dispatcher https://mnemo.example.com
// Run:      mnemo-pc run         (uses ~/.mnemo-pc.json from previous pair)
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/Maykbiletti/mnemo/packages/pc-agent/internal/pair"
	"github.com/Maykbiletti/mnemo/packages/pc-agent/internal/ws"
)

const Version = "0.1.0-dev"

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "pair":
		cmdPair()
	case "run":
		cmdRun()
	case "version", "--version", "-v":
		fmt.Printf("mnemo-pc %s\n", Version)
	case "help", "--help", "-h":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n\n", os.Args[1])
		usage()
		os.Exit(2)
	}
}

func cmdPair() {
	fs := flag.NewFlagSet("pair", flag.ExitOnError)
	dispatcher := fs.String("dispatcher", "", "dispatcher URL, e.g. https://mnemo.example.com")
	code := fs.String("code", "", "6-digit pairing code shown by dispatcher")
	deviceName := fs.String("name", defaultDeviceName(), "human-readable device name")
	_ = fs.Parse(os.Args[2:])

	if *dispatcher == "" || *code == "" {
		fmt.Fprintln(os.Stderr, "usage: mnemo-pc pair --dispatcher <url> --code <6-digit>")
		os.Exit(2)
	}

	cfg, err := pair.Pair(*dispatcher, *code, *deviceName)
	if err != nil {
		fmt.Fprintf(os.Stderr, "pair failed: %v\n", err)
		os.Exit(1)
	}
	if err := cfg.Save(); err != nil {
		fmt.Fprintf(os.Stderr, "could not save config: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("paired as device_id=%s; config saved to %s\n", cfg.DeviceID, cfg.Path())
	fmt.Println("now run: mnemo-pc run")
}

func cmdRun() {
	cfg, err := pair.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "no pairing config — run 'mnemo-pc pair --dispatcher <url> --code <code>' first\n")
		os.Exit(1)
	}
	if err := ws.Run(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "run failed: %v\n", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Println(`mnemo-pc — connects this device to a Mnemo dispatcher.

Usage:
  mnemo-pc pair --dispatcher <url> --code <6-digit>   Pair this device.
  mnemo-pc run                                        Connect + serve RPCs.
  mnemo-pc version                                    Print version.
  mnemo-pc help                                       This message.

After a successful pair the dispatcher can drive this device:
  - screenshot, tap_at, type_text, key_press
  - file_read, file_write
  - shell_exec
  - app_open
Sensitive operations require a confirmation push to the device owner.`)
}

func defaultDeviceName() string {
	if h, err := os.Hostname(); err == nil {
		return h
	}
	return "unknown-device"
}
