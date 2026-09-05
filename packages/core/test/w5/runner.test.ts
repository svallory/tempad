import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config/env";
import { openDatabase } from "../../src/db/database";
import type { W5Config } from "../../src/intent/config";
import { applyIncremental, ensureTables } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";
import type { Classifier, ClassifierResult, ClassifierWindow } from "../../src/w5/classifier";
import { enqueueJob } from "../../src/w5/jobs";
import { runOnce } from "../../src/w5/runner";

registerAllProjections();

function makeConfig(claudeDir: string): Config {
  return {
    mondayApiToken: "t",
    mondayUser: "u",
    ghUser: "u",
    ghOrgs: [],
    ghIncludePersonal: false,
    ghToken: undefined,
    gitAuthorEmails: [],
    claudeDirs: [claudeDir],
    hostSlug: "host",
    tz: "UTC",
    since: "2020-01-01",
    home: claudeDir,
  };
}

const config: W5Config = {
  model: "m",
  throttleMinutes: 10,
  watchTurns: 3,
  askMinActivityMinutes: 20,
  askBudgetMinutes: 30,
  askExpireTurns: 2,
  backfillDays: 15,
};

const good: ClassifierResult = {
  segments: [
    {
      startedAt: "2026-09-04T15:00:00.000Z",
      endedAt: "2026-09-04T15:20:00.000Z",
      what: "fix walk order",
      why: "ship marko-ui",
      matchedQuest: null,
      proposedQuest: null,
      matchedActivity: null,
      isSwitch: false,
      trigger: null,
      confidence: 0.9,
      questions: [],
    },
  ],
};

class FakeClassifier implements Classifier {
  constructor(private readonly result: ClassifierResult | (() => Promise<ClassifierResult>)) {}
  async classify(_window: ClassifierWindow): Promise<ClassifierResult> {
    if (typeof this.result === "function") return this.result();
    return this.result;
  }
}

function seedSessionWithMessages(
  database: ReturnType<typeof openDatabase>,
  filePath: string,
): void {
  const lines = [
    JSON.stringify({
      type: "user",
      uuid: "m1",
      sessionId: "s1",
      timestamp: "2026-09-04T15:00:00.000Z",
      cwd: "/w/marko-ui",
      gitBranch: "main",
      message: { role: "user", content: "fix walk order" },
    }),
    JSON.stringify({
      type: "user",
      uuid: "m2",
      sessionId: "s1",
      timestamp: "2026-09-04T15:20:00.000Z",
      cwd: "/w/marko-ui",
      gitBranch: "main",
      message: { role: "user", content: "done" },
    }),
  ];
  writeFileSync(filePath, `${lines.join("\n")}\n`);

  database
    .query(
      `INSERT INTO claude_sessions
        (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch,
         started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES ('s1', ?, 'p', ?, '/w/marko-ui', 'personal', 'marko-ui', 'marko-ui', 'main',
               '2026-09-04T15:00:00.000Z', '2026-09-04T15:20:00.000Z', 2, 0, '[]', 'host', '2026-09-04T15:20:00.000Z')`,
    )
    .run(filePath.slice(0, filePath.lastIndexOf("/")), filePath);
  database
    .query(
      "INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview) VALUES ('m1', 's1', '2026-09-04T15:00:00.000Z', 'user', 0, 'fix walk order')",
    )
    .run();
  database
    .query(
      "INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview) VALUES ('m2', 's1', '2026-09-04T15:20:00.000Z', 'user', 0, 'done')",
    )
    .run();
}

function seedHero(database: ReturnType<typeof openDatabase>) {
  ensureTables(database);
  const store = new EventStore(database);
  applyIncremental(
    database,
    store.append({
      actor: "hero",
      kind: "hero.created",
      subject: "H1",
      payload: { name: "Saulo" },
    }),
  );
}

describe("runOnce", () => {
  test("claims a job, classifies, applies, completes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-runner-test-"));
    try {
      const database = openDatabase(":memory:");
      seedHero(database);
      seedSessionWithMessages(database, join(dir, "s1.jsonl"));
      enqueueJob(database, { sessionId: "s1", forced: true, throttleMinutes: 10 });

      const classifier = new FakeClassifier(good);
      const logs: string[] = [];
      const result = await runOnce(database, makeConfig(dir), config, classifier, {
        now: "2026-09-04T15:21:00.000Z",
        log: (line) => logs.push(line),
      });

      expect(result.ran).toBe(true);
      expect(result.sessionId).toBe("s1");
      expect(result.summary?.traces).toBe(1);

      const job = database.query("SELECT state FROM w5_jobs").get() as { state: string };
      expect(job.state).toBe("done");

      const run = database.query("SELECT session_id FROM w5_runs").get() as { session_id: string };
      expect(run.session_id).toBe("s1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns ran: false when there is no job", async () => {
    const database = openDatabase(":memory:");
    seedHero(database);
    const classifier = new FakeClassifier(good);
    const result = await runOnce(database, makeConfig("/tmp"), config, classifier, {
      log: () => {},
    });
    expect(result.ran).toBe(false);
  });

  test("a classifier that throws marks the job failed and does not throw", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-runner-test-"));
    try {
      const database = openDatabase(":memory:");
      seedHero(database);
      seedSessionWithMessages(database, join(dir, "s1.jsonl"));
      enqueueJob(database, { sessionId: "s1", forced: true, throttleMinutes: 10 });

      const classifier = new FakeClassifier(async () => {
        throw new Error("boom");
      });
      const logs: string[] = [];
      const result = await runOnce(database, makeConfig(dir), config, classifier, {
        now: "2026-09-04T15:21:00.000Z",
        log: (line) => logs.push(line),
      });

      expect(result.ran).toBe(true);
      const job = database.query("SELECT state, error FROM w5_jobs").get() as {
        state: string;
        error: string;
      };
      expect(job.state).toBe("failed");
      expect(job.error).toContain("boom");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
