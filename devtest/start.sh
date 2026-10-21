#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# No public hosting, billing changes, or background model services.
# This runs only after the owner explicitly creates/starts the Codespace.
test -f devtest/.build/quality-verified || { echo 'Setup tests have not passed; refusing to start.'; exit 1; }
log=/tmp/compass-quality-start.log
pidfile=/tmp/compass-quality-server.pid
version=0.2.1

healthy() {
  python3 - "$version" <<'PY'
import json, sys, urllib.request
try:
    with urllib.request.urlopen('http://127.0.0.1:8765/api/health', timeout=.5) as response:
        health = json.load(response)
        sys.exit(0 if response.status == 200 and health.get('version') == sys.argv[1] else 1)
except OSError:
    sys.exit(1)
PY
}

if healthy; then
  echo 'Concert Compass private test is already ready on port 8765.'
  exit 0
fi

if [[ -f "$pidfile" ]]; then
  oldpid=$(<"$pidfile")
  if [[ "$oldpid" =~ ^[0-9]+$ ]] && kill -0 "$oldpid" 2>/dev/null; then
    kill "$oldpid" || true
    for _ in {1..20}; do kill -0 "$oldpid" 2>/dev/null || break; sleep .1; done
  fi
  rm -f "$pidfile"
fi

# Earlier builds did not write a PID file. Clear only this known private
# development server when its health endpoint is absent or out of date.
while read -r oldpid; do
  kill "$oldpid" 2>/dev/null || true
done < <(pgrep -f '[p]ython3 devtest/server\.py' || true)

nohup python3 devtest/server.py > "$log" 2>&1 < /dev/null &
pid=$!
printf '%s\n' "$pid" > "$pidfile"
for _ in {1..30}; do
  if healthy; then
    echo 'Concert Compass private test is ready on port 8765.'
    exit 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then break; fi
  sleep .1
done

rm -f "$pidfile"
echo 'Concert Compass did not start. Its diagnostic log follows:' >&2
cat "$log" >&2 || true
exit 1
