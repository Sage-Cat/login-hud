UUID := login-hud-v2@sagecat.local
EXTENSION_DIR ?= $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
DIST_DIR ?= dist
FILES := metadata.json extension.js stylesheet.css

.PHONY: all check install uninstall package clean

all: check

check:
	@jq -e '.uuid == "$(UUID)" and .["shell-version"] == ["46"] and (.version | type == "number")' metadata.json >/dev/null
	@node --input-type=module --check < extension.js
	@eslint extension.js
	@node tests/lifecycle-static.mjs
	@echo "check: metadata, JavaScript syntax, and ESLint passed"

install: check
	install -d "$(EXTENSION_DIR)"
	install -m 0644 $(FILES) "$(EXTENSION_DIR)"
	@echo "Installed to $(EXTENSION_DIR)"
	@echo "Enable with: gnome-extensions enable $(UUID)"

uninstall:
	rm -rf "$(EXTENSION_DIR)"
	@echo "Removed $(EXTENSION_DIR)"

package: check
	mkdir -p "$(DIST_DIR)"
	gnome-extensions pack --force --out-dir "$(DIST_DIR)"
	@echo "Package written to $(DIST_DIR)/$(UUID).shell-extension.zip"

clean:
	rm -rf "$(DIST_DIR)"
