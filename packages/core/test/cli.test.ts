import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSync } from "../src/cli.ts";
import type { Collector, SyncSummary } from "../src/collect/types.ts";
import { openDatabase } from "../src/db/database.ts";
import { getSyncState } from "../src/db/sync-state.ts";

function makeCollector(
  name: Collector["name"],
  behavior: "succeed" | "fail",
  calls: string[],
): Collector {
  return {
    name,
    async sync(): Promise<SyncSummary> {
      calls.push(name);
      if (behavior === "fail") throw new Error(`${name} failed`);
      return { source: name, inserted: 1, updated: 0, deleted: 0, warnings: [] };
    },
  };
}

describe("runSync", () => {
  test("a failing collector does not stop the others; exit is 1; sync_state untouched on failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-cli-test-"));
    const dbPath = join(dir, "tempad.db");

    try {
      const database = openDatabase(dbPath);
      const calls: string[] = [];
      const failing = makeCollector("monday", "fail", calls);
      const succeeding = makeCollector("github", "succeed", calls);

      const { summaries, failed } = await runSync(database, {} as never, [failing, succeeding]);

      expect(calls).toEqual(["monday", "github"]);
      expect(failed).toBe(true);
      expect(summaries).toHaveLength(2);

      expect(getSyncState(database, "monday")).toBeUndefined();
      expect(getSyncState(database, "github")).toBeDefined();

      database.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("all succeeding collectors report failed = false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-cli-test-"));
    const dbPath = join(dir, "tempad.db");

    try {
      const database = openDatabase(dbPath);
      const calls: string[] = [];
      const a = makeCollector("monday", "succeed", calls);
      const b = makeCollector("claude", "succeed", calls);

      const { failed } = await runSync(database, {} as never, [a, b]);
      expect(failed).toBe(false);
      expect(getSyncState(database, "monday")).toBeDefined();
      expect(getSyncState(database, "claude")).toBeDefined();

      database.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("report command default output path", () => {
  test("writes to TEMPAD_HOME/reports/<kind>-<from>-<to>.md and echoes to stdout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-cli-report-test-"));

    try {
      await Bun.write(
        join(dir, ".env"),
        [
          "MONDAY_API_TOKEN=token",
          "MONDAY_USER=1",
          "GH_USER=octocat",
          "GH_ORGS=acme",
          "GH_INCLUDE_PERSONAL=false",
          "GIT_AUTHOR_EMAILS=octocat@example.com",
          "CLAUDE_DIRS=/tmp/does-not-matter",
          "HOST_SLUG=test-host",
          "TZ=America/Sao_Paulo",
          "SINCE=2026-01-01",
        ].join("\n"),
      );

      const proc = Bun.spawn({
        cmd: [
          "bun",
          "run",
          join(import.meta.dir, "..", "src", "cli.ts"),
          "report",
          "daily",
          "--from",
          "2026-09-01",
          "--to",
          "2026-09-01",
        ],
        env: { ...process.env, TEMPAD_HOME: dir },
        stdout: "pipe",
        stderr: "pipe",
      });

      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);

      const outPath = join(dir, "reports", "daily-2026-09-01-2026-09-01.md");
      const file = Bun.file(outPath);
      expect(await file.exists()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cli process", () => {
  test("unknown report kind exits 2", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", join(import.meta.dir, "..", "src", "cli.ts"), "report", "weekly"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(2);
  });

  test("no command exits 2", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", join(import.meta.dir, "..", "src", "cli.ts")],
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(2);
  });
});
