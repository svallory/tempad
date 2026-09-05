#!/usr/bin/env bash
set -u

payload="$(cat)"
session_id="$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"

log_file="${TEMPAD_HOME:-$HOME/.tempad}/logs/w5.log"
mkdir -p "$(dirname "$log_file")" 2>/dev/null || true

if [ -z "$session_id" ]; then
  exit 0
fi

if [ -z "${TEMPAD_BIN:-}" ]; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%S.000Z) w5-prompt.sh: TEMPAD_BIN not set, skipping context for session $session_id" >> "$log_file"
  exit 0
fi

context="$(eval "$TEMPAD_BIN" w5 context --session "$session_id" 2>/dev/null || true)"

if [ -n "$context" ]; then
  context_json=$(printf '%s' "$context" | sed 's/\\/\\\\/g; s/"/\\"/g' | awk '{printf "%s\\n", $0}')
  printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"%s"}}\n' "$context_json"
fi

exit 0
