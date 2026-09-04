# TemPad

> Reconstruct what you, and your agents, worked on, hour by hour, from git, Monday.com and Claude Code sessions.

[![CI](https://github.com/svallory/tempad/actions/workflows/ci.yml/badge.svg)](https://github.com/svallory/tempad/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-orange.svg)](LICENSE)

<p align="center">
  <!-- Mascot: Miss Minutes belongs to Marvel/Disney and is not redistributed here. -->
  <a href="https://marvelcinematicuniverse.fandom.com/wiki/Miss_Minutes">
    <img
      src="docs/assets/mascot-placeholder.svg"
      alt="TemPad mascot placeholder, an orange retro clock"
      width="160"
    />
  </a>
</p>

Named after the TVA's handheld from _Loki_: the device that opens time doors and watches the Sacred Timeline for branches. This one only looks backwards. It pulls every trace of work you leave behind, stores it in SQLite, and lets you rebuild a timesheet you would otherwise have to remember.

## Why

Commits get batched and pushed days after the work. Planning leaves no git trace. Agents run in the background across several checkouts. By Friday nobody remembers what Tuesday was. TemPad collects the evidence so the report writes itself.

## Features

- **Collectors** for Monday.com items assigned to you, GitHub commits and pull requests across one or more orgs (plus optional personal repos), and Claude Code session transcripts from any number of `~/.claude*` directories.
- **Incremental sync.** Each source records where it left off. Git repos are kept as bare mirrors so rewritten history is re-diffed, not trusted.
- **Path rules** map working directories to `org` and `project` using WHATWG `URLPattern` syntax, so `~/work/:org/:project/:rest*` is a complete config.
- **Reports** per day, per project, and hour by hour, generated deterministically from the database as Markdown.
- **w5 table** (planned): a Claude Code hook that periodically asks a small model _who, when, what, why, where_ about the live session and stores the answer.

## Installation

Requires [Bun](https://bun.sh) 1.3+.

```sh
bun install
```

## Quick Start

```sh
mkdir -p ~/.tempad
cp packages/core/.env.example ~/.tempad/.env   # fill in tokens and ids
cp packages/core/tempad.example.toml ~/.tempad/tempad.toml

bun run tempad sync            # all sources
bun run tempad sync claude     # one source
bun run tempad report daily --from 2026-08-18 --to 2026-08-28
```

Reports land in `~/.tempad/reports/`.

## Repository layout

| Path            | Purpose                                                             |
| --------------- | ------------------------------------------------------------------- |
| `packages/core` | TypeScript library and `tempad` binary: schema, collectors, reports |
| `apps/`         | Runnable programs (a Go TUI built on charmbracelet is planned)      |
| `libs/`         | Private, bundle-time only packages shared across apps               |
| `docs/specs`    | Design specs                                                        |

Tooling: [moon](https://moonrepo.dev) orchestrates tasks, [Biome](https://biomejs.dev) lints and formats JS/TS/JSON, [dprint](https://dprint.dev) formats Markdown, TOML and YAML.

## Roadmap

- **Profiles.** All configuration is global today (`TEMPAD_HOME/.env` and `tempad.toml`), so one machine can only serve one TemPad. Introduce profiles (for example `~/.tempad/profiles/<name>/` selected by `--profile` or `TEMPAD_PROFILE`) so a person can keep separate databases, tokens and path rules per client or per persona.
- **w5 table.** A Claude Code hook that periodically asks a small model _who, when, what, why, where_ (plus outcome) about the live session and stores the answer, with a batch backfill over existing sessions. This is what turns raw sessions into "things I worked on", including side quests that never produced a commit.
- **Weekly objective table.** Per weekday, per project: distinct objectives, shipped vs abandoned, side-quest share. Depends on w5.
- **Goals and drift.** Set goals and get a nudge when time drifts away from them for too long.
- **TUI** in Go (charmbracelet) under `apps/`.
- **Timesheet export.** A recurring agent that fills external timesheets (Deel) from the reports.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
