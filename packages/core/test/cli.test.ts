import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSync } from "../src/cli.ts";
import type { Collector, SyncSummary } from "../src/collect/types.ts";
import { openDatabase } from "../src/db/database.ts";
import { getSyncState, setSyncState } from "../src/db/sync-state.ts";

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

describe("tempad sync --full", () => {
  test("clears sync_state for the selected source so a full rescan happens even when a normal sync would skip everything", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-cli-full-test-"));

    try {
      const claudeDir = join(dir, "claude");
      mkdirSync(join(claudeDir, "projects", "full-test"), { recursive: true });
      writeFileSync(
        join(claudeDir, "projects", "full-test", "session-1.jsonl"),
        `${JSON.stringify({
          type: "user",
          uuid: "u1",
          sessionId: "sess-full-1",
          timestamp: "2026-01-01T10:00:00.000Z",
          origin: { kind: "human" },
          message: { role: "user", content: "hello" },
        })}\n`,
      );

      await Bun.write(
        join(dir, ".env"),
        [
          "MONDAY_API_TOKEN=token",
          "MONDAY_USER=1",
          "GH_USER=octocat",
          "GH_ORGS=acme",
          "GH_INCLUDE_PERSONAL=false",
          "GIT_AUTHOR_EMAILS=octocat@example.com",
          `CLAUDE_DIRS=${claudeDir}`,
          "HOST_SLUG=test-host",
          "TZ=UTC",
          "SINCE=2020-01-01",
        ].join("\n"),
      );

      const database = openDatabase(join(dir, "tempad.db"));
      // A future last_sync_at makes the claude collector's mtime-skip filter reject
      // every file in a normal sync -- the file was written well before "now".
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      setSyncState(database, "claude", future);
      database.close();

      const runCli = (args: string[]) =>
        Bun.spawn({
          cmd: ["bun", "run", join(import.meta.dir, "..", "src", "cli.ts"), ...args],
          env: { ...process.env, TEMPAD_HOME: dir },
          stdout: "pipe",
          stderr: "pipe",
        }).exited;

      expect(await runCli(["sync", "claude"])).toBe(0);

      const afterNormalSync = openDatabase(join(dir, "tempad.db"));
      const countAfterNormal = (
        afterNormalSync.query("SELECT COUNT(*) as count FROM claude_sessions").get() as {
          count: number;
        }
      ).count;
      afterNormalSync.close();
      expect(countAfterNormal).toBe(0);

      expect(await runCli(["sync", "claude", "--full"])).toBe(0);

      const afterFullSync = openDatabase(join(dir, "tempad.db"));
      const countAfterFull = (
        afterFullSync.query("SELECT COUNT(*) as count FROM claude_sessions").get() as {
          count: number;
        }
      ).count;
      afterFullSync.close();
      expect(countAfterFull).toBe(1);
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
