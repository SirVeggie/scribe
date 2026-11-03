#!/bin/sh
# Installs (or reinstalls) Scribe's headless Linux release and runs it as a systemd user service (#942).
#   curl -fsSL https://github.com/SirVeggie/scribe/releases/latest/download/install-linux.sh | sh
# SCRIBE_APP_DIR: where the app goes (default ~/.local/share/scribe-app). Data goes to ~/.local/share/scribe (SCRIBE_HOME overrides).
# SCRIBE_RELEASE_URL: the release folder to install from (default: the latest GitHub release).
# After this, Scribe updates itself from releases (Settings → Updates, on this device or a paired one).
set -eu

BASE="${SCRIBE_RELEASE_URL:-https://github.com/SirVeggie/scribe/releases/latest/download}"
APP="${SCRIBE_APP_DIR:-$HOME/.local/share/scribe-app}"
BIN="$HOME/.local/bin"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) ;;
  *) echo "The headless release is built for Linux x86_64 only." >&2; exit 1 ;;
esac
for tool in curl tar sha256sum; do
  command -v "$tool" >/dev/null || { echo "Needs $tool." >&2; exit 1; }
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$BASE/latest.json" -o "$TMP/latest.json"
# The manifest is small and flat; read the linux asset without needing jq.
ASSET="$(tr -d '\n ' < "$TMP/latest.json" | sed -n 's/.*"linux-x64-headless":{\([^}]*\)}.*/\1/p')"
FILE="$(printf '%s' "$ASSET" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')"
SHA="$(printf '%s' "$ASSET" | sed -n 's/.*"sha256":"\([0-9a-fA-F]*\)".*/\1/p')"
[ -n "$FILE" ] && [ -n "$SHA" ] || { echo "The latest release has no Linux download." >&2; exit 1; }
case "$FILE" in http*://*) URL="$FILE" ;; *) URL="$BASE/$FILE" ;; esac

echo "Downloading $URL"
curl -fL --progress-bar "$URL" -o "$TMP/scribe.tar.gz"
echo "$SHA  $TMP/scribe.tar.gz" | sha256sum -c --quiet -

if [ -x "$APP/bin/scribe" ]; then
  "$APP/bin/scribe" --stop >/dev/null 2>&1 || true
fi
mkdir -p "$TMP/new"
tar -xzf "$TMP/scribe.tar.gz" -C "$TMP/new" --strip-components=1
rm -rf "$APP.old"
[ -d "$APP" ] && mv "$APP" "$APP.old"
mkdir -p "$(dirname "$APP")"
mv "$TMP/new" "$APP"
rm -rf "$APP.old"

mkdir -p "$BIN"
ln -sf "$APP/bin/scribe" "$BIN/scribe"
echo "Installed $(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$APP/install.json") in $APP"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "Add $BIN to PATH to run scribe from a shell." ;; esac

if command -v systemctl >/dev/null; then
  "$APP/bin/scribe" service install
else
  echo "No systemd: start it with $APP/bin/scribe --daemon"
fi
