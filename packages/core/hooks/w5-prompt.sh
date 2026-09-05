#!/usr/bin/env bash
set -u

payload="$(cat)"
session_id="$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"

if [ -z "$session_id" ]; then
  exit 0
fi

tempad_bin="${TEMPAD_BIN:-tempad}"
context="$("$tempad_bin" w5 context --session "$session_id" 2>/dev/null || true)"

if [ -n "$context" ]; then
  context_json=$(printf '%s' "$context" | sed 's/\\/\\\\/g; s/"/\\"/g' | awk '{printf "%s\\n", $0}')
  printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"%s"}}\n' "$context_json"
fi

exit 0
