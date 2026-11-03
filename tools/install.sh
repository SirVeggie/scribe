#!/bin/sh
# Installs (or reinstalls) Scribe's headless release on Linux or macOS and runs it as a background service:
# a systemd user service on Linux, a launchd agent on macOS (#942, #971).
#   curl -fsSL https://github.com/SirVeggie/scribe/releases/latest/download/install.sh | sh
# (install-linux.sh in a release is this same script, for links made before macOS was supported.)
# SCRIBE_APP_DIR: where the app goes (default ~/.local/share/scribe-app). Data goes to ~/.local/share/scribe on
# Linux and ~/Library/Application Support/Scribe on macOS (SCRIBE_HOME overrides).
# SCRIBE_RELEASE_URL: the release folder to install from (default: the latest GitHub release).
# After this, Scribe updates itself from releases (Settings → Updates, on this device or a paired one).
set -eu

BASE="${SCRIBE_RELEASE_URL:-https://github.com/SirVeggie/scribe/releases/latest/download}"
APP="${SCRIBE_APP_DIR:-$HOME/.local/share/scribe-app}"
BIN="$HOME/.local/bin"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) TARGET=linux-x64-headless ;;
  Darwin-arm64) TARGET=macos-arm64-headless ;;
  Darwin-x86_64)
    # A shell under Rosetta reports x86_64 on Apple silicon: take the native build there.
    if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then TARGET=macos-arm64-headless; else TARGET=macos-x64-headless; fi ;;
  *) echo "The headless release is built for Linux x86_64 and macOS (Apple silicon or Intel) only." >&2; exit 1 ;;
esac
if command -v sha256sum >/dev/null; then SHA256="sha256sum"; else SHA256="shasum -a 256"; fi
for tool in curl tar; do
  command -v "$tool" >/dev/null || { echo "Needs $tool." >&2; exit 1; }
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$BASE/latest.json" -o "$TMP/latest.json"
# The manifest is small and flat; read this platform's asset without needing jq.
ASSET="$(tr -d '\n ' < "$TMP/latest.json" | sed -n "s/.*\"$TARGET\":{\([^}]*\)}.*/\1/p")"
FILE="$(printf '%s' "$ASSET" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')"
SHA="$(printf '%s' "$ASSET" | sed -n 's/.*"sha256":"\([0-9a-fA-F]*\)".*/\1/p')"
[ -n "$FILE" ] && [ -n "$SHA" ] || { echo "The latest release has no $TARGET download." >&2; exit 1; }
case "$FILE" in http*://*) URL="$FILE" ;; *) URL="$BASE/$FILE" ;; esac

echo "Downloading $URL"
curl -fL --progress-bar "$URL" -o "$TMP/scribe.tar.gz"
echo "$SHA  $TMP/scribe.tar.gz" | $SHA256 -c - >/dev/null || { echo "The download does not match its checksum." >&2; exit 1; }

if [ -x "$APP/bin/scribe" ]; then
  "$APP/bin/scribe" --stop >/dev/null 2>&1 || true
fi
mkdir -p "$TMP/new"
tar -xzf "$TMP/scribe.tar.gz" -C "$TMP/new" --strip-components=1
# curl sets no quarantine flag, but a copy fetched through a browser would have one, and Gatekeeper would stop it.
[ "$(uname -s)" = Darwin ] && xattr -dr com.apple.quarantine "$TMP/new" 2>/dev/null || true
rm -rf "$APP.old"
[ -d "$APP" ] && mv "$APP" "$APP.old"
mkdir -p "$(dirname "$APP")"
mv "$TMP/new" "$APP"
rm -rf "$APP.old"

mkdir -p "$BIN"
ln -sf "$APP/bin/scribe" "$BIN/scribe"
echo "Installed $(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$APP/install.json") in $APP"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "Add $BIN to PATH to run scribe from a shell." ;; esac

if [ "$(uname -s)" = Darwin ] || command -v systemctl >/dev/null; then
  "$APP/bin/scribe" service install
else
  echo "No systemd: start it with $APP/bin/scribe --daemon"
fi
