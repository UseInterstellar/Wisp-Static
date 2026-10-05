#!/usr/bin/env bash
# Runs Wisp as the Deplexo web process, and stunl alongside it as a second
# public entrypoint. Wisp is primary: if it dies the container exits so Deplexo
# restarts it. The tunnel is best effort and never takes the app down.
set -uo pipefail

PORT="${PORT:-3000}"
HOST="${HOST:-0.0.0.0}"

node src/index.js &
WISP_PID=$!

stunl_supervisor_pid=""

shutdown() {
  [ -n "$stunl_supervisor_pid" ] && kill "$stunl_supervisor_pid" 2>/dev/null
  kill "$WISP_PID" 2>/dev/null
  wait "$WISP_PID" 2>/dev/null
  exit 0
}
trap shutdown TERM INT

# Wait for Wisp to accept connections before pointing the tunnel at it.
wisp_ready() {
  node -e '
    const s = require("net").connect(Number(process.argv[1]), "127.0.0.1");
    s.on("connect", () => { s.destroy(); process.exit(0); });
    s.on("error", () => process.exit(1));
    setTimeout(() => process.exit(1), 1000);
  ' "$PORT" 2>/dev/null
}

for _ in $(seq 1 30); do
  if wisp_ready; then
    echo "wisp is accepting connections on ${HOST}:${PORT}"
    break
  fi
  if ! kill -0 "$WISP_PID" 2>/dev/null; then
    echo "wisp exited during startup" >&2
    wait "$WISP_PID"
    exit 1
  fi
  sleep 1
done

if [ -z "${STUNL_API_KEY:-}" ]; then
  echo "STUNL_API_KEY is not set - serving Wisp only, no stunl tunnel" >&2
  wait "$WISP_PID"
  exit $?
fi

# stunl's free tier caps a session at 60 minutes, so the tunnel is expected to
# drop and must be re-established. Backoff is capped so a hard failure (bad key,
# quota exhausted) doesn't spin.
supervise_stunl() {
  local delay=2
  local args=(-host 127.0.0.1 -port "$PORT" -plain)

  if [ -n "${STUNL_ID:-}" ]; then
    args+=(-id "$STUNL_ID")
  fi

  while true; do
    echo "stunl: opening tunnel to 127.0.0.1:${PORT}"
    local started=$SECONDS
    stunl "${args[@]}"
    local code=$?
    local ran=$(( SECONDS - started ))

    # A session that stayed up is a healthy expiry, not a failure, so reconnect
    # promptly. Only genuine fast failures (bad key, quota) are backed off.
    if [ "$ran" -ge 60 ]; then
      delay=2
    fi

    echo "stunl: exited with ${code} after ${ran}s, reconnecting in ${delay}s" >&2
    sleep "$delay"

    if [ "$ran" -lt 60 ] && [ "$delay" -lt 60 ]; then
      delay=$(( delay * 2 ))
    fi
  done
}

supervise_stunl &
stunl_supervisor_pid=$!

# Only Wisp is critical. The supervisor keeps retrying the tunnel on its own.
wait "$WISP_PID"
status=$?

kill "$stunl_supervisor_pid" 2>/dev/null
exit "$status"
