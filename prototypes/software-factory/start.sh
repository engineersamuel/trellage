#!/usr/bin/env bash
# Run the TypeScript coordinator (Bun) and both frontend dev servers in the background.
# Each service restarts when it exits; the coordinator also restarts when its code changes.
#   ./start.sh            # start with the native Copilot subscription (gh auth token)
#   ./start.sh proxy      # route all model traffic through copilot-proxy-rs (localhost:8080)
#   ./start.sh stop | status | logs
set -euo pipefail
cd "$(dirname "$0")"
SELF="$PWD/$(basename "$0")"
STATE="${SF_STATE_DIR:-${TMPDIR:-/tmp}/software-factory}"
LOGS="$STATE/logs"
PIDFILE="$STATE/supervisor.pid"
mkdir -p "$LOGS"

running() { [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

# Restart a service whenever it exits.
supervise() {
  local name=$1; shift
  while true; do
    echo "$(date '+%F %T') start $name" >>"$LOGS/$name.log"
    "$@" >>"$LOGS/$name.log" 2>&1 || true
    echo "$(date '+%F %T') $name exited, restart in 2s" >>"$LOGS/$name.log"
    sleep 2
  done
}

# Stop the restart loops first, then the services they started (bun, vite), then the runtimes.
shutdown() {
  local loops services=""
  loops=$(pgrep -P $$ || true)
  for p in $loops; do services="$services $(pgrep -P "$p" || true)"; done
  kill $loops 2>/dev/null || true
  kill $services 2>/dev/null || true
  pkill -f "$PWD/coordinator/node_modules/@github/copilot-sdk-" || true
  pkill -f "$PWD/web-(react|foldkit)/node_modules/.bin/vite" || true
  rm -f "$PIDFILE"
  exit 0
}

run() {
  [[ -d coordinator/node_modules ]] || (cd coordinator && bun install --frozen-lockfile)
  [[ -d web-react/node_modules ]] || (cd web-react && npm ci -q)
  [[ -d web-foldkit/node_modules ]] || (cd web-foldkit && npm ci -q --legacy-peer-deps)
  trap shutdown TERM INT
  supervise coordinator bash -c 'cd coordinator && exec bun --watch src/main.ts' &
  supervise copilotkit bash -c 'cd web-react && exec npx vite --port 5173 --strictPort' &
  supervise foldkit bash -c 'cd web-foldkit && exec npx vite --port 5174 --strictPort' &
  wait
}

MODE="${1:-native}"
case "$MODE" in
  stop)
    running && kill "$(cat "$PIDFILE")" && echo stopped || echo "not running"
    ;;
  status)
    running && echo "running (supervisor pid $(cat "$PIDFILE"), logs $LOGS)" || echo "not running"
    for u in http://127.0.0.1:7700/api/info http://localhost:5173/copilotkit.html http://localhost:5174/; do
      printf '%-42s %s\n' "$u" "$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$u" || true)"
    done
    ;;
  logs)
    tail -n 30 -F "$LOGS"/*.log
    ;;
  _run)
    run
    ;;
  native | proxy)
    export SF_AUTH=$MODE
    export SF_MODEL="${SF_MODEL:-claude-sonnet-5.5}"
    if [[ "$SF_AUTH" == proxy ]] && ! curl -fsS "${SF_PROXY_URL:-http://localhost:8080/v1}/models" >/dev/null; then
      echo "copilot-proxy-rs is not reachable at ${SF_PROXY_URL:-http://localhost:8080/v1}" >&2
      exit 1
    fi
    running && "$SELF" stop && sleep 2
    nohup "$SELF" _run >>"$LOGS/supervisor.log" 2>&1 &
    echo $! >"$PIDFILE"
    echo "auth=$SF_AUTH model=$SF_MODEL  (logs: ./start.sh logs, stop: ./start.sh stop)"
    echo "  Option 1 CopilotKit : http://localhost:5173/copilotkit.html"
    echo "  Option 2 Foldkit    : http://localhost:5174/"
    echo "  Coordinator API     : http://127.0.0.1:7700/"
    ;;
  *)
    echo "usage: $0 [native|proxy|stop|status|logs]" >&2
    exit 2
    ;;
esac
