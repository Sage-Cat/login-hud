SHELL := /bin/sh

UUID := $(shell jq -r .uuid metadata.json)
VERSION := $(shell jq -r .version metadata.json)
DIST_DIR ?= dist
ARCHIVE := $(DIST_DIR)/$(UUID).shell-extension.zip
CHECKSUM := $(ARCHIVE).sha256
FILES := metadata.json extension.js stylesheet.css
ESLINT := $(if $(wildcard node_modules/.bin/eslint),node_modules/.bin/eslint,eslint)

.PHONY: all check test install uninstall package release-artifacts verify-package clean

all: check

check:
	@command -v jq >/dev/null || { echo "check: jq is required" >&2; exit 1; }
	@command -v node >/dev/null || { echo "check: Node.js is required" >&2; exit 1; }
	@command -v $(ESLINT) >/dev/null || { echo "check: run npm ci or install eslint" >&2; exit 1; }
	@command -v shellcheck >/dev/null || { echo "check: shellcheck is required" >&2; exit 1; }
	@jq -e '.uuid == "$(UUID)" and .["shell-version"] == ["46"] and (.version | type == "number")' metadata.json >/dev/null
	@grep -Fq "uuid='$(UUID)'" scripts/install.sh scripts/uninstall.sh scripts/verify-package.sh
	@node --input-type=module --check < extension.js
	@$(ESLINT) extension.js
	@shellcheck scripts/*.sh tests/check.sh
	@node tests/lifecycle-static.mjs
	@echo "check: metadata, JavaScript syntax, and ESLint passed"

test: check

install: check
	./scripts/install.sh

uninstall:
	./scripts/uninstall.sh

package: check
	@command -v gnome-extensions >/dev/null || { echo "package: gnome-extensions is required" >&2; exit 1; }
	@mkdir -p "$(DIST_DIR)"
	@gnome-extensions pack --force --out-dir "$(DIST_DIR)" .
	@./scripts/verify-package.sh "$(ARCHIVE)"
	@echo "package: wrote $(ARCHIVE) (version $(VERSION))"

verify-package:
	@./scripts/verify-package.sh "$(ARCHIVE)"

release-artifacts: package
	@cd "$(DIST_DIR)" && sha256sum "$(notdir $(ARCHIVE))" > "$(notdir $(CHECKSUM))"
	@echo "release: wrote $(CHECKSUM)"

clean:
	rm -f "$(DIST_DIR)"/*.shell-extension.zip "$(DIST_DIR)"/*.shell-extension.zip.sha256
