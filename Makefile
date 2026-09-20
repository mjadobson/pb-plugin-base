POCKETBASE_VERSION := v0.40.4
XPB_VERSION := v0.0.5
PLUGIN_MODULE := github.com/mjadobson/pb-plugin-base

.PHONY: build-pocketbase-binary
build-pocketbase-binary:
	@set -eu; \
	build_dir="$$(mktemp -d "$${TMPDIR:-/tmp}/pb-plugin-base-build.XXXXXX")"; \
	trap 'rm -rf "$$build_dir"' EXIT HUP INT TERM; \
	printf '%s\n' \
		'package main' \
		'' \
		'import (' \
		'    "log"' \
		'' \
		'    _ "$(PLUGIN_MODULE)"' \
		'    "github.com/pocketbase/pocketbase"' \
		'    "github.com/pocketbuilds/xpb"' \
		'    _ "github.com/pocketbuilds/xpb/pkg/plugins/defaults"' \
		')' \
		'' \
		'func main() {' \
		'    app := pocketbase.New()' \
		'    if err := xpb.Setup(app); err != nil {' \
		'        log.Fatal(err)' \
		'    }' \
		'    if err := app.Start(); err != nil {' \
		'        log.Fatal(err)' \
		'    }' \
		'}' > "$$build_dir/main.go"; \
	cd "$$build_dir"; \
	go mod init pocketbase; \
	go mod edit -replace=$(PLUGIN_MODULE)=$(CURDIR); \
	go get github.com/pocketbase/pocketbase@$(POCKETBASE_VERSION); \
	go get github.com/pocketbuilds/xpb@$(XPB_VERSION); \
	go get $(PLUGIN_MODULE)@v0.0.0; \
	go mod tidy; \
	go build -trimpath \
		-ldflags '-s -w -X github.com/pocketbuilds/xpb.version=$(XPB_VERSION)' \
		-o "$(CURDIR)/pocketbase" .
