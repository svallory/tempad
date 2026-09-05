#!/usr/bin/env bash
set -u

payload="$(cat)"
session_id="$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
hook_event_name="$(printf '%s' "$payload" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"

if [ -z "$session_id" ]; then
  exit 0
fi

tempad_bin="${TEMPAD_BIN:-tempad}"

if [ "$hook_event_name" != "Stop" ]; then
  "$tempad_bin" w5 enqueue --session "$session_id" --forced || true
else
  "$tempad_bin" w5 enqueue --session "$session_id" || true
fi

exit 0
