#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# No public hosting, billing changes, or background model services.
# This runs only after the owner explicitly creates/starts the Codespace.
test -f devtest/.build/quality-verified || { echo 'Setup tests have not passed; refusing to start.'; exit 1; }
nohup python3 devtest/server.py > /tmp/compass-quality-start.log 2>&1 < /dev/null &
echo 'Open http://localhost:8765 when the private forwarded port appears. Keep its visibility Private.'
