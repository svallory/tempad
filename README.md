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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
