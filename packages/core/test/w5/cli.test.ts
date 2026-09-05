import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config/env";
import { openDatabase } from "../../src/db/database";
import { defaultIntentConfig } from "../../src/intent/config";
import { ensureTables } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import type { SpawnFn } from "../../src/w5/cli";
import { runW5Command } from "../../src/w5/cli";

registerAllProjections();

function makeConfig(home: string): Config {
  return {
    mondayApiToken: "t",
    mondayUser: "u",
    ghUser: "u",
    ghOrgs: [],
    ghIncludePersonal: false,
    ghToken: undefined,
    gitAuthorEmails: [],
    claudeDirs: [],
    hostSlug: "host",
    tz: "UTC",
    since: "2020-01-01",
    home,
  };
}

describe("w5 enqueue", () => {
  test("spawns the runner detached when the lock is free", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-cli-test-"));
    try {
      const database = openDatabase(":memory:");
      const spawnCalls: Parameters<SpawnFn>[0][] = [];
      const spawn: SpawnFn = (options) => {
        spawnCalls.push(options);
      };

      const code = await runW5Command(["enqueue", "--session", "s1"], {
        database,
        config: makeConfig(dir),
        intentConfig: defaultIntentConfig(),
        stdout: () => {},
        spawn,
      });

      expect(code).toBe(0);
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]?.detached).toBe(true);
      expect(spawnCalls[0]?.cmd).toContain("w5");
      expect(spawnCalls[0]?.cmd).toContain("run");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not spawn the runner when the lock file exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-cli-test-"));
    try {
      writeFileSync(join(dir, "w5.lock"), "12345");
      const database = openDatabase(":memory:");
      const spawnCalls: unknown[] = [];
      const spawn: SpawnFn = (options) => {
        spawnCalls.push(options);
      };

      await runW5Command(["enqueue", "--session", "s1"], {
        database,
        config: makeConfig(dir),
        intentConfig: defaultIntentConfig(),
        stdout: () => {},
        spawn,
      });

      expect(spawnCalls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a stale lock does not wedge the queue: enqueue --forced clears it and spawns the runner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-cli-test-"));
    try {
      const lockPath = join(dir, "w5.lock");
      writeFileSync(lockPath, "12345");
      const staleTime = new Date(Date.now() - 31 * 60_000);
      utimesSync(lockPath, staleTime, staleTime);

      const database = openDatabase(":memory:");
      const spawnCalls: Parameters<SpawnFn>[0][] = [];
      const spawn: SpawnFn = (options) => {
        spawnCalls.push(options);
      };

      const code = await runW5Command(["enqueue", "--session", "s1", "--forced"], {
        database,
        config: makeConfig(dir),
        intentConfig: defaultIntentConfig(),
        stdout: () => {},
        spawn,
      });

      expect(code).toBe(0);
      expect(existsSync(lockPath)).toBe(false);
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]?.detached).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("w5 run stale lock", () => {
  test("removes a lock older than 30 minutes and continues", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-cli-test-"));
    try {
      const lockPath = join(dir, "w5.lock");
      writeFileSync(lockPath, "12345");
      const staleTime = new Date(Date.now() - 31 * 60_000);
      utimesSync(lockPath, staleTime, staleTime);

      const database = openDatabase(":memory:");
      const spawn: SpawnFn = () => {};

      const code = await runW5Command(["run", "--detached"], {
        database,
        config: makeConfig(dir),
        intentConfig: defaultIntentConfig(),
        stdout: () => {},
        spawn,
      });

      expect(code).toBe(0);

      const logContent = await Bun.file(join(dir, "logs", "w5.log")).text();
      expect(logContent).toContain("stale");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a fresh lock blocks the run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-cli-test-"));
    try {
      const lockPath = join(dir, "w5.lock");
      writeFileSync(lockPath, "12345");

      const database = openDatabase(":memory:");
      const spawnCalls: unknown[] = [];
      const spawn: SpawnFn = (options) => {
        spawnCalls.push(options);
      };

      await runW5Command(["run", "--detached"], {
        database,
        config: makeConfig(dir),
        intentConfig: defaultIntentConfig(),
        stdout: () => {},
        spawn,
      });

      expect(spawnCalls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("w5 backend selection", () => {
  test("claude-cli backend never requires ANTHROPIC_API_KEY and spawns the claude command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-cli-test-"));
    const previousKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const database = openDatabase(":memory:");
      ensureTables(database);
      const sessionFilePath = join(dir, "s1.jsonl");
      writeFileSync(
        sessionFilePath,
        `${JSON.stringify({
          type: "user",
          uuid: "m1",
          sessionId: "s1",
          timestamp: "2026-09-05T10:00:00.000Z",
          message: { role: "user", content: "work" },
        })}\n`,
      );
      database
        .query(
          `INSERT INTO claude_sessions
            (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch,
             started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
           VALUES ('s1', ?, 'p', ?, '/w/p', 'personal', 'p', 't', 'main',
                   '2026-09-05T10:00:00.000Z', '2026-09-05T10:00:00.000Z', 1, 0, '[]', 'host', '2026-09-05T10:00:00.000Z')`,
        )
        .run(dir, sessionFilePath);
      database
        .query(
          "INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview) VALUES ('m1', 's1', '2026-09-05T10:00:00.000Z', 'user', 0, 'work')",
        )
        .run();
      database
        .query(
          "INSERT INTO w5_jobs (session_id, kind, forced, requested_at, state) VALUES ('s1', 'classify', 1, '2026-09-05T10:00:00.000Z', 'queued')",
        )
        .run();

      const spawn: SpawnFn = () => {};
      const intentConfig = defaultIntentConfig();
      intentConfig.w5.backend = "claude-cli";
      intentConfig.w5.claudeCommand = "definitely-not-a-real-binary-xyz";
      const code = await runW5Command(["run"], {
        database,
        config: makeConfig(dir),
        intentConfig,
        stdout: () => {},
        spawn,
      });

      expect(code).toBe(0);
      const job = database.query("SELECT state, error FROM w5_jobs").get() as {
        state: string;
        error: string;
      };
      expect(job.state).toBe("failed");
      expect(job.error).not.toContain("ANTHROPIC_API_KEY not set");
    } finally {
      if (previousKey !== undefined) process.env.ANTHROPIC_API_KEY = previousKey;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("w5 run without ANTHROPIC_API_KEY", () => {
  test("marks the job failed and exits 0 without throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-cli-test-"));
    const previousKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const database = openDatabase(":memory:");
      ensureTables(database);
      const sessionFilePath = join(dir, "s1.jsonl");
      writeFileSync(
        sessionFilePath,
        `${JSON.stringify({
          type: "user",
          uuid: "m1",
          sessionId: "s1",
          timestamp: "2026-09-05T10:00:00.000Z",
          message: { role: "user", content: "work" },
        })}\n`,
      );
      database
        .query(
          `INSERT INTO claude_sessions
            (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch,
             started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
           VALUES ('s1', ?, 'p', ?, '/w/p', 'personal', 'p', 't', 'main',
                   '2026-09-05T10:00:00.000Z', '2026-09-05T10:00:00.000Z', 1, 0, '[]', 'host', '2026-09-05T10:00:00.000Z')`,
        )
        .run(dir, sessionFilePath);
      database
        .query(
          "INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview) VALUES ('m1', 's1', '2026-09-05T10:00:00.000Z', 'user', 0, 'work')",
        )
        .run();
      database
        .query(
          "INSERT INTO w5_jobs (session_id, kind, forced, requested_at, state) VALUES ('s1', 'classify', 1, '2026-09-05T10:00:00.000Z', 'queued')",
        )
        .run();

      const spawn: SpawnFn = () => {};
      const intentConfig = defaultIntentConfig();
      intentConfig.w5.backend = "api";
      const code = await runW5Command(["run"], {
        database,
        config: makeConfig(dir),
        intentConfig,
        stdout: () => {},
        spawn,
      });

      expect(code).toBe(0);
      const job = database.query("SELECT state, error FROM w5_jobs").get() as {
        state: string;
        error: string;
      };
      expect(job.state).toBe("failed");
      expect(job.error).toContain("ANTHROPIC_API_KEY not set");
      expect(job.error).not.toContain("at ");

      const logContent = readFileSync(join(dir, "logs", "w5.log"), "utf8");
      expect(logContent).toContain("ANTHROPIC_API_KEY not set");
      expect(logContent).not.toMatch(/\bat .*:\d+:\d+/);
      expect(logContent).not.toContain("    at ");
    } finally {
      if (previousKey !== undefined) process.env.ANTHROPIC_API_KEY = previousKey;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
