#!/bin/sh
# Installs the HotMic LAN helper (Chrome native messaging host) for the current user.
# Usage: sh native-host/install-macos.sh [extension-id]
set -eu

EXT_ID="${1:-ijjmpbibipdmmloibgobofjoindgplop}"
HOST_NAME="com.hotmic.lan"
HERE="$(cd "$(dirname "$0")" && pwd)"

# Chrome starts helpers with a minimal PATH, so resolve node's absolute path now.
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "Node.js 18+ is required (https://nodejs.org). Install it, then re-run." >&2
  exit 1
fi
MAJOR="$("$NODE" -p "process.versions.node.split('.')[0]")"
if [ "$MAJOR" -lt 18 ]; then echo "Node.js 18+ is required (found $MAJOR)." >&2; exit 1; fi

INSTALL_DIR="$HOME/Library/Application Support/HotMic"
mkdir -p "$INSTALL_DIR"
cp "$HERE/hotmic_host.mjs" "$INSTALL_DIR/"
cat > "$INSTALL_DIR/hotmic_host.sh" <<EOF
#!/bin/sh
exec "$NODE" "$INSTALL_DIR/hotmic_host.mjs" "\$@"
EOF
chmod +x "$INSTALL_DIR/hotmic_host.sh"

TARGET="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$TARGET"
cat > "$TARGET/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "HotMic LAN discovery helper",
  "path": "$INSTALL_DIR/hotmic_host.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF

echo "Installed $HOST_NAME for extension $EXT_ID"
echo "  helper:   $INSTALL_DIR"
echo "  manifest: $TARGET/$HOST_NAME.json"
echo
echo "macOS may ask to allow Google Chrome to find devices on your local network; allow it."
