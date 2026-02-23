#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./push-theme-override.sh desktop-hostname
#   ./push-theme-override.sh user@192.168.1.88

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  echo "Usage: $0 <ssh-target>"
  exit 1
fi

if /usr/bin/defaults read -g AppleInterfaceStyle >/dev/null 2>&1; then
  APPEARANCE="dark"
else
  APPEARANCE="light"
fi

UPDATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SOURCE="$(hostname)"

ssh "$TARGET" "mkdir -p ~/.pi/agent && cat > ~/.pi/agent/theme-sync-override.json <<'JSON'
{
  \"appearance\": \"$APPEARANCE\",
  \"updatedAt\": \"$UPDATED_AT\",
  \"source\": \"$SOURCE\"
}
JSON"

echo "Pushed appearance=$APPEARANCE to $TARGET"
