#!/usr/bin/env bash
set -u

payload="$(cat)"
session_id="$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
hook_event_name="$(printf '%s' "$payload" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"

log_file="${TEMPAD_HOME:-$HOME/.tempad}/logs/w5.log"
mkdir -p "$(dirname "$log_file")" 2>/dev/null || true

if [ -z "$session_id" ]; then
  exit 0
fi

if [ -z "${TEMPAD_BIN:-}" ]; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%S.000Z) w5-stop.sh: TEMPAD_BIN not set, skipping enqueue for session $session_id" >> "$log_file"
  exit 0
fi

if [ "$hook_event_name" != "Stop" ]; then
  eval "$TEMPAD_BIN" w5 enqueue --session "$session_id" --forced || true
else
  eval "$TEMPAD_BIN" w5 enqueue --session "$session_id" || true
fi

exit 0
