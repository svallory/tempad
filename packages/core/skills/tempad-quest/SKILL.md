---
name: tempad-quest
description: Declare which quest this session (or subagent) is pursuing, so tempad tracks work under the right outcome instead of guessing. Use at session start, when the outcome changes, and inside every subagent before it starts work.
---

# tempad-quest

TemPad no longer guesses what you're working on — you declare it. Declare early and re-declare
whenever the outcome shifts.

## Read your current declaration first

Every `UserPromptSubmit` hook injects a line like:

```
tempad: session <id>, declared quest: <title>. Declare with the tempad-quest skill if this prompt starts a different outcome.
```

`<title>` is either the declared quest's real title, or the literal word `none` when nothing is
declared yet — never a placeholder to fill in yourself. This line names your own session id and
your current declared quest. Do not track either yourself — read it fresh each turn.

## Declare at session start

As soon as you know what the user's first prompt is asking for, declare it:

```
tempad quest declare --session <id> --new "<title>" --outcome "<text>" --commitment personal
```

Infer `--new`'s `--title`/`--outcome` from the prompt. Set `--commitment promised` when the
user is asking for something they expect delivered, `--commitment exploratory` when it's
investigation with no fixed deliverable, `--commitment personal` otherwise.

If the work is continuing an existing quest, use its id instead:

```
tempad quest declare --session <id> --quest <existing-quest-id>
```

## Re-declare on outcome change

When the prompt shifts what you're doing mid-session:

- If the old outcome is simply done, declare the new one plainly (no `--origin`).
- If the new work is a detour from the quest you were just pursuing (a blocker, a question that
  needs answering first, idle waiting, or curiosity), declare it as a branch:

```
tempad quest declare --session <id> --new "<title>" --outcome "<text>" \
  --origin <quest id you're branching from> --trigger "<the sentence that caused the pivot>" \
  --kind waiting|blocker|curiosity|unknown
```

## Declare inside every subagent

Before a subagent starts substantive work, it must declare its own quest with `--parent`, even
when its outcome is the same as the parent's:

```
tempad quest declare --session <subagent session id> --parent <parent session id> \
  --quest <quest id> --plan "first maneuver; second maneuver"
```

Learn the parent's session id from the parent's own hook-context line — never guess it. An
explicit declaration (not silent inheritance) is what lets tempad tell "forgot to declare" apart
from "same outcome, deliberately."

## Plan

Pass `--plan "a; b; c"` with coarse, semicolon-separated steps you expect to take. It's optional
and may be empty — a rough plan is more useful than none.
