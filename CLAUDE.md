# TemPad

Reconstructs work history (hour by hour) from git, Monday.com and Claude Code session transcripts into SQLite, then generates timesheet reports.

## Layout

- `packages/core` — TypeScript library + `tempad` bin: schema, collectors, reports. Bun runtime, `bun:sqlite`.
- `apps/` — runnable programs. A Go TUI (charmbracelet) is planned.
- `libs/` — private bundle-time packages. Never published.
- `docs/specs/` — design specs. Read the relevant spec before changing a subsystem.

Runtime data never lives in the repo. `TEMPAD_HOME` (default `~/.tempad`) holds `.env`, `tempad.toml`, `tempad.db`, `repos/`, `reports/`.

## Commands

```sh
bun install
bun run lint          # biome check
bun run fmt           # biome + dprint write
bun run typecheck
bun test
moon run :test        # same through moon
```

## Conventions

- Package manager: bun. Never npm.
- Biome for JS/TS/JSON. dprint for Markdown/TOML/YAML. Go uses gofmt.
- Full words in identifiers (`repository`, not `repo`, in code; `repos/` as a directory name is fine).
- Environment variables that are required have no defaults; missing ones throw at startup.
- Tests in `bun test`, colocated as `*.test.ts`. Fixtures under `packages/core/test/fixtures`.
- Commits: `type(scope): summary`.

## Gotchas

- Monday.com's API `people` column filter by numeric id returns nothing. Filter client-side by name or id from the column's JSON value.
- Claude session `.jsonl` files mix timestamped message lines with untimestamped metadata lines (`custom-title`, `agent-name`, `bridge-session`). Join them on `sessionId`.
- Git history rewrites: collectors re-scan an overlap window and delete rows whose sha is no longer reachable from any ref in the mirror.
