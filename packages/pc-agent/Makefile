# mnemo-pc cross-platform build targets
#
# Usage:
#   make             build for current platform
#   make all         build for win/mac-arm/mac-amd/linux
#   make win         Windows amd64
#   make mac         macOS arm64 + amd64
#   make linux       Linux amd64
#   make clean       remove dist/

BINARY  := mnemo-pc
PKG     := ./cmd/mnemo-pc
DIST    := dist
LDFLAGS := -ldflags "-s -w"

.PHONY: all win mac linux clean

build:
	go build $(LDFLAGS) -o $(BINARY) $(PKG)

all: win mac linux

win:
	@mkdir -p $(DIST)
	GOOS=windows GOARCH=amd64 go build $(LDFLAGS) -o $(DIST)/$(BINARY)-win-amd64.exe $(PKG)

mac:
	@mkdir -p $(DIST)
	GOOS=darwin GOARCH=arm64 go build $(LDFLAGS) -o $(DIST)/$(BINARY)-mac-arm64 $(PKG)
	GOOS=darwin GOARCH=amd64 go build $(LDFLAGS) -o $(DIST)/$(BINARY)-mac-amd64 $(PKG)

linux:
	@mkdir -p $(DIST)
	GOOS=linux GOARCH=amd64 go build $(LDFLAGS) -o $(DIST)/$(BINARY)-linux-amd64 $(PKG)

clean:
	rm -rf $(DIST) $(BINARY) $(BINARY).exe
