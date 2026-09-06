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
  backend: "claude-cli",
  claudeCommand: "claude",
  timeoutSeconds: 180,
  activityIdleMinutes: 45,
  memoryHours: 8,
  memoryActivities: 10,
  overlapMessages: 3,
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
      continuesActivity: null,
      newActivityReason: "first work of the session",
      isSwitch: false,
      trigger: null,
      confidence: 0.9,
      questions: [],
    },
  ],
  sessionNote: null,
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

const THREE_WINDOW_MESSAGES = [
  ["w1a", "2026-09-04T15:00:00.000Z", "fix walk order"],
  ["w1b", "2026-09-04T15:10:00.000Z", "still on walk order"],
  ["w2a", "2026-09-04T15:20:00.000Z", "same bug, new idea"],
  ["w2b", "2026-09-04T15:30:00.000Z", "almost there"],
  // Two hours later: past activityIdleMinutes, so the activity closes as idle.
  ["w3a", "2026-09-04T17:30:00.000Z", "back to the walk order bug"],
  ["w3b", "2026-09-04T17:40:00.000Z", "fixed it"],
] as const;

/**
 * One session whose messages arrive across three runs: two back to back, then a
 * long idle gap before the third. `count` is how many messages exist so far, so
 * each run sees only the transcript written before it, as a live session does.
 */
function seedThreeWindowSession(
  database: ReturnType<typeof openDatabase>,
  filePath: string,
  count: number,
): void {
  const timestamps = THREE_WINDOW_MESSAGES.slice(0, count);

  writeFileSync(
    filePath,
    `${timestamps
      .map(([uuid, ts, text]) =>
        JSON.stringify({
          type: "user",
          uuid,
          sessionId: "s1",
          timestamp: ts,
          cwd: "/w/marko-ui",
          gitBranch: "main",
          message: { role: "user", content: text },
        }),
      )
      .join("\n")}\n`,
  );

  const lastTs = timestamps.at(-1)?.[1] ?? "2026-09-04T15:00:00.000Z";
  database
    .query(
      `INSERT OR REPLACE INTO claude_sessions
        (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch,
         started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES ('s1', ?, 'p', ?, '/w/marko-ui', 'personal', 'marko-ui', 'marko-ui', 'main',
               '2026-09-04T15:00:00.000Z', ?, ?, 0, '[]', 'host', ?)`,
    )
    .run(filePath.slice(0, filePath.lastIndexOf("/")), filePath, lastTs, timestamps.length, lastTs);

  const insert = database.query(
    "INSERT OR REPLACE INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview) VALUES (?, 's1', ?, 'user', 0, ?)",
  );
  for (const [uuid, ts, text] of timestamps) insert.run(uuid, ts, text);
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

  test("computes sessionActivityMinutes from claude_messages instead of hardcoding 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-runner-test-"));
    try {
      const database = openDatabase(":memory:");
      seedHero(database);
      seedSessionWithMessages(database, join(dir, "s1.jsonl"));
      enqueueJob(database, { sessionId: "s1", forced: false, throttleMinutes: 10 });

      const withQuestion: ClassifierResult = {
        segments: [
          {
            startedAt: "2026-09-04T15:00:00.000Z",
            endedAt: "2026-09-04T15:20:00.000Z",
            what: "fix walk order",
            why: "unknown",
            matchedQuest: null,
            proposedQuest: null,
            matchedActivity: null,
            continuesActivity: null,
            newActivityReason: "first work of the window",
            isSwitch: false,
            trigger: null,
            confidence: 0.6,
            questions: ["why"],
          },
        ],
        sessionNote: null,
      };
      const classifier = new FakeClassifier(withQuestion);
      const lowWatchConfig: W5Config = { ...config, watchTurns: 2, askMinActivityMinutes: 20 };

      await runOnce(database, makeConfig(dir), lowWatchConfig, classifier, {
        now: "2026-09-04T15:21:00.000Z",
        log: () => {},
      });

      // session spans exactly 20 minutes (15:00 -> 15:20), meeting askMinActivityMinutes;
      // with sessionActivityMinutes hardcoded to 0 this question would never qualify to be asked.
      const question = database.query("SELECT state FROM questions").get() as { state: string };
      expect(question.state).toBe("asked");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  test("stores the classifier's sessionNote on w5_runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-runner-test-"));
    try {
      const database = openDatabase(":memory:");
      seedHero(database);
      seedSessionWithMessages(database, join(dir, "s1.jsonl"));
      enqueueJob(database, { sessionId: "s1", forced: true, throttleMinutes: 10 });

      const withNote: ClassifierResult = {
        ...good,
        sessionNote: "coming back to the walk order bug after lunch",
      };
      await runOnce(database, makeConfig(dir), config, new FakeClassifier(withNote), {
        now: "2026-09-04T15:21:00.000Z",
        log: () => {},
      });

      const run = database
        .query("SELECT session_note FROM w5_runs WHERE session_id = 's1'")
        .get() as { session_note: string | null };
      expect(run.session_note).toBe("coming back to the walk order bug after lunch");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a session_end job closes every open activity of the session and clears the note", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-runner-test-"));
    try {
      const database = openDatabase(":memory:");
      seedHero(database);
      seedSessionWithMessages(database, join(dir, "s1.jsonl"));
      enqueueJob(database, {
        sessionId: "s1",
        forced: true,
        throttleMinutes: 10,
        kind: "session_end",
      });

      const withNote: ClassifierResult = { ...good, sessionNote: "a note that must not survive" };
      await runOnce(database, makeConfig(dir), config, new FakeClassifier(withNote), {
        now: "2026-09-04T15:21:00.000Z",
        log: () => {},
      });

      const open = database
        .query("SELECT COUNT(*) as count FROM activities WHERE closed_at IS NULL")
        .get() as { count: number };
      expect(open.count).toBe(0);

      const closed = database.query("SELECT close_reason FROM activities").all() as {
        close_reason: string | null;
      }[];
      expect(closed.every((row) => row.close_reason === "session_end")).toBe(true);
      expect(closed.length).toBeGreaterThan(0);

      const run = database
        .query("SELECT session_note FROM w5_runs WHERE session_id = 's1'")
        .get() as { session_note: string | null };
      expect(run.session_note).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("three windows of one session: windows 2 and 3 reuse window 1's activity, the idle gap makes window 3 continue it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-runner-test-"));
    try {
      const database = openDatabase(":memory:");
      seedHero(database);
      const filePath = join(dir, "s1.jsonl");
      seedThreeWindowSession(database, filePath, 2);

      // The classifier reuses whatever candidate the window slice offers: an open
      // activity via matchedActivity, else a closed one via continuesActivity.
      class MemoryClassifier implements Classifier {
        public sawOpenCandidates: number[] = [];
        async classify(window: ClassifierWindow): Promise<ClassifierResult> {
          this.sawOpenCandidates.push(window.sessionOpenActivities.length);
          const open = window.sessionOpenActivities.at(-1) ?? null;
          const closed = window.recentActivities.find((a) => a.closedAt !== null) ?? null;
          const first = window.messages[0]?.ts ?? "2026-09-04T15:00:00.000Z";
          const last = window.messages.at(-1)?.ts ?? first;
          return {
            segments: [
              {
                startedAt: first,
                endedAt: last,
                what: "fix walk order",
                why: "ship marko-ui",
                matchedQuest: open?.questId ?? closed?.questId ?? null,
                proposedQuest: null,
                matchedActivity: open?.activityId ?? null,
                continuesActivity: open === null ? (closed?.activityId ?? null) : null,
                newActivityReason:
                  open === null && closed === null ? "nothing open to reuse yet" : null,
                isSwitch: false,
                trigger: null,
                confidence: 0.9,
                questions: [],
              },
            ],
            sessionNote: "on the walk order bug",
          };
        }
      }

      const classifier = new MemoryClassifier();
      const runAt = async (now: string, messagesSoFar: number) => {
        seedThreeWindowSession(database, filePath, messagesSoFar);
        enqueueJob(database, { sessionId: "s1", forced: true, throttleMinutes: 10, now });
        await runOnce(database, makeConfig(dir), config, classifier, { now, log: () => {} });
      };

      await runAt("2026-09-04T15:11:00.000Z", 2);
      await runAt("2026-09-04T15:31:00.000Z", 4);
      await runAt("2026-09-04T17:41:00.000Z", 6);

      const activities = database
        .query("SELECT id, continues, close_reason FROM activities ORDER BY opened_at")
        .all() as { id: string; continues: string | null; close_reason: string | null }[];

      // Window 1 opened one activity; window 2 reused it; the idle gap closed it and
      // window 3 opened exactly one more that points back at it.
      expect(activities).toHaveLength(2);
      expect(activities[0]?.close_reason).toBe("idle");
      expect(activities[1]?.continues).toBe(activities[0]?.id);

      // Window 2 saw window 1's activity still open; window 3 saw none open (idle-closed).
      expect(classifier.sawOpenCandidates).toEqual([0, 1, 0]);

      const traceCount = database.query("SELECT COUNT(*) as count FROM traces").get() as {
        count: number;
      };
      expect(traceCount.count).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
