import { describe, expect, test } from "bun:test";
import type { Config } from "../../src/config/env";
import { openDatabase } from "../../src/db/database";
import type { W5Config } from "../../src/intent/config";
import { applyIncremental, ensureTables } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";
import { backfill } from "../../src/w5/backfill";
import type { Classifier, ClassifierResult, ClassifierWindow } from "../../src/w5/classifier";

registerAllProjections();

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

function makeConfig(): Config {
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
    home: "/tmp",
  };
}

class FakeClassifier implements Classifier {
  public calls = 0;
  async classify(window: ClassifierWindow): Promise<ClassifierResult> {
    this.calls += 1;
    const first = window.messages[0]?.ts ?? "2026-09-04T15:00:00.000Z";
    const last = window.messages.at(-1)?.ts ?? first;
    return {
      segments: [
        {
          startedAt: first,
          endedAt: last,
          what: "work",
          why: "ship",
          matchedQuest: null,
          proposedQuest: null,
          matchedActivity: null,
          continuesActivity: null,
          newActivityReason: "first work of the window",
          isSwitch: false,
          trigger: null,
          confidence: 0.9,
          questions: [],
        },
      ],
      sessionNote: null,
    };
  }
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

function seedSession(
  database: ReturnType<typeof openDatabase>,
  input: { id: string; endedAt: string; messageTimestamps?: string[] },
) {
  database
    .query(
      `INSERT INTO claude_sessions
        (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch,
         started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES (?, '/c', 'p', ?, '/w/p', 'personal', 'p', 't', 'main', ?, ?, 1, 0, '[]', 'host', ?)`,
    )
    .run(input.id, `/c/p/${input.id}.jsonl`, input.endedAt, input.endedAt, input.endedAt);
  const timestamps = input.messageTimestamps ?? [input.endedAt];
  for (const [index, ts] of timestamps.entries()) {
    database
      .query(
        "INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview) VALUES (?, ?, ?, 'user', 0, 'work')",
      )
      .run(`${input.id}-m${index}`, input.id, ts);
  }
}

describe("backfill", () => {
  test("classifies both sessions, a second run classifies none, asking disabled leaves no questions", async () => {
    const database = openDatabase(":memory:");
    seedHero(database);
    seedSession(database, { id: "s1", endedAt: "2026-09-04T15:20:00.000Z" });
    seedSession(database, { id: "s2", endedAt: "2026-09-04T16:00:00.000Z" });

    const classifier = new FakeClassifier();
    const logs: string[] = [];

    const firstResult = await backfill(database, makeConfig(), config, classifier, {
      days: 15,
      now: "2026-09-04T17:00:00.000Z",
      log: (line) => logs.push(line),
    });

    expect(firstResult.sessionsClassified).toBe(2);
    expect(firstResult.windowsFailed).toBe(0);
    expect(classifier.calls).toBe(2);

    const questionCount = database.query("SELECT COUNT(*) as count FROM questions").get() as {
      count: number;
    };
    expect(questionCount.count).toBe(0);

    const secondResult = await backfill(database, makeConfig(), config, classifier, {
      days: 15,
      now: "2026-09-04T17:00:00.000Z",
      log: (line) => logs.push(line),
    });

    expect(secondResult.sessionsClassified).toBe(0);
    expect(secondResult.windowsClassified).toBe(0);
  });

  test("coverage is segment-independent: a window a classifier splits into 2+ segments is still recognized as covered on the next run", async () => {
    const database = openDatabase(":memory:");
    seedHero(database);
    seedSession(database, { id: "s1", endedAt: "2026-09-04T15:20:00.000Z" });

    class TwoSegmentClassifier implements Classifier {
      public calls = 0;
      async classify(window: ClassifierWindow): Promise<ClassifierResult> {
        this.calls += 1;
        const first = window.messages[0]?.ts ?? "2026-09-04T15:00:00.000Z";
        const last = window.messages.at(-1)?.ts ?? first;
        const mid = new Date((Date.parse(first) + Date.parse(last)) / 2).toISOString();
        return {
          segments: [
            {
              startedAt: first,
              endedAt: mid,
              what: "work part 1",
              why: "ship",
              matchedQuest: null,
              proposedQuest: null,
              matchedActivity: null,
              continuesActivity: null,
              newActivityReason: "first work of the window",
              isSwitch: false,
              trigger: null,
              confidence: 0.9,
              questions: [],
            },
            {
              startedAt: mid,
              endedAt: last,
              what: "work part 2",
              why: "ship",
              matchedQuest: null,
              proposedQuest: null,
              matchedActivity: null,
              continuesActivity: null,
              newActivityReason: "first work of the window",
              isSwitch: false,
              trigger: null,
              confidence: 0.9,
              questions: [],
            },
          ],
          sessionNote: null,
        };
      }
    }

    const classifier = new TwoSegmentClassifier();
    const logs: string[] = [];

    const firstResult = await backfill(database, makeConfig(), config, classifier, {
      days: 15,
      now: "2026-09-04T17:00:00.000Z",
      log: (line) => logs.push(line),
    });

    expect(firstResult.windowsClassified).toBe(1);
    // Two segments -> two traces, neither of which individually spans the
    // whole window -- the bug this test guards against would have neither
    // trace match the window's exact bounds, so the window looks uncovered
    // forever and gets reclassified every run.
    const traceCount = database.query("SELECT COUNT(*) as count FROM traces").get() as {
      count: number;
    };
    expect(traceCount.count).toBe(2);

    const secondResult = await backfill(database, makeConfig(), config, classifier, {
      days: 15,
      now: "2026-09-04T17:00:00.000Z",
      log: (line) => logs.push(line),
    });

    expect(secondResult.windowsClassified).toBe(0);
    expect(secondResult.windowsSkipped).toBe(1);
    expect(classifier.calls).toBe(1);
  });

  test("legacy fallback: a live trace nested in the window's bounds counts as covered even with no w5_windows row", async () => {
    const database = openDatabase(":memory:");
    seedHero(database);
    // Window spans 15:00-15:20 (two messages); the legacy trace is nested
    // strictly inside it (15:05-15:15), as a real pre-upgrade trace's bounds
    // (from classifier segment timestamps, not the raw chunk bounds) often
    // are.
    seedSession(database, {
      id: "s1",
      endedAt: "2026-09-04T15:20:00.000Z",
      messageTimestamps: ["2026-09-04T15:00:00.000Z", "2026-09-04T15:20:00.000Z"],
    });

    const store = new EventStore(database);
    applyIncremental(
      database,
      store.append({
        actor: "hook",
        kind: "activity.opened",
        subject: "A1",
        payload: { objective: "work" },
        at: "2026-09-04T15:05:00.000Z",
      }),
    );
    applyIncremental(
      database,
      store.append({
        actor: "backfill",
        kind: "trace.recorded",
        subject: "T1",
        sessionId: "s1",
        payload: {
          activity: "A1",
          tool: "claude-code",
          place: "p",
          source: "session",
          started_at: "2026-09-04T15:05:00.000Z",
          ended_at: "2026-09-04T15:15:00.000Z",
          who: "hero",
          what: "work",
          why: "ship",
          where: "personal/p",
          how: "claude-code",
          confidence: 0.9,
          classified_by: "assistant",
        },
      }),
    );
    // No window.classified event / w5_windows row -- this trace predates the
    // primary coverage mechanism, as every trace in the real database does.

    const windowRowCount = database.query("SELECT COUNT(*) as count FROM w5_windows").get() as {
      count: number;
    };
    expect(windowRowCount.count).toBe(0);

    const classifier = new FakeClassifier();
    const logs: string[] = [];

    const result = await backfill(database, makeConfig(), config, classifier, {
      days: 15,
      now: "2026-09-04T17:00:00.000Z",
      log: (line) => logs.push(line),
    });

    expect(result.windowsClassified).toBe(0);
    expect(result.windowsSkipped).toBe(1);
    expect(classifier.calls).toBe(0);
  });

  test("a failed final window does not stop earlier windows and is retried next run", async () => {
    const database = openDatabase(":memory:");
    seedHero(database);
    // Two windows spaced 40 minutes apart (> windowMinutes = 30). The second (last)
    // window fails, mirroring the real incident where the tail window timed out.
    seedSession(database, {
      id: "s1",
      endedAt: "2026-09-04T15:40:00.000Z",
      messageTimestamps: ["2026-09-04T15:00:00.000Z", "2026-09-04T15:40:00.000Z"],
    });

    class FlakyClassifier implements Classifier {
      public calls = 0;
      async classify(window: ClassifierWindow): Promise<ClassifierResult> {
        this.calls += 1;
        // Fail every attempt on the second window (calls 2 and 3: initial + retry)
        // during the first backfill run; succeed on the retried run (call 4).
        if (this.calls === 2 || this.calls === 3) {
          throw new Error("boom");
        }
        const first = window.messages[0]?.ts ?? "2026-09-04T15:00:00.000Z";
        const last = window.messages.at(-1)?.ts ?? first;
        return {
          segments: [
            {
              startedAt: first,
              endedAt: last,
              what: "work",
              why: "ship",
              matchedQuest: null,
              proposedQuest: null,
              matchedActivity: null,
              continuesActivity: null,
              newActivityReason: "first work of the window",
              isSwitch: false,
              trigger: null,
              confidence: 0.9,
              questions: [],
            },
          ],
          sessionNote: null,
        };
      }
    }

    const classifier = new FlakyClassifier();
    const logs: string[] = [];

    const firstResult = await backfill(database, makeConfig(), config, classifier, {
      days: 15,
      now: "2026-09-04T18:00:00.000Z",
      log: (line) => logs.push(line),
    });

    // First window succeeds (call 1). Second (last) window fails twice
    // (calls 2, 3: initial + retry), counted as one failed window.
    expect(firstResult.windowsClassified).toBe(1);
    expect(firstResult.windowsFailed).toBe(1);
    expect(firstResult.sessionsClassified).toBe(1);
    expect(logs.some((line) => line.includes("backfill: failed s1 window 1: boom"))).toBe(true);

    const traceCountAfterFirstRun = database
      .query("SELECT COUNT(*) as count FROM traces")
      .get() as {
      count: number;
    };
    expect(traceCountAfterFirstRun.count).toBe(1);

    // Only the failed second window is retried; the first window's trace already
    // covers it, so it is not reprocessed.
    const secondResult = await backfill(database, makeConfig(), config, classifier, {
      days: 15,
      now: "2026-09-04T18:00:00.000Z",
      log: (line) => logs.push(line),
    });

    expect(secondResult.sessionsSkipped).toBe(0);
    expect(secondResult.windowsClassified).toBe(1);
    expect(secondResult.windowsFailed).toBe(0);
    expect(classifier.calls).toBe(4);
  });

  test("all windows failing yields sessionsClassified=0 and windowsFailed>0", async () => {
    const database = openDatabase(":memory:");
    seedHero(database);
    seedSession(database, { id: "s1", endedAt: "2026-09-04T15:20:00.000Z" });

    class AlwaysFailsClassifier implements Classifier {
      async classify(): Promise<ClassifierResult> {
        throw new Error("always fails");
      }
    }

    const classifier = new AlwaysFailsClassifier();
    const logs: string[] = [];

    const result = await backfill(database, makeConfig(), config, classifier, {
      days: 15,
      now: "2026-09-04T17:00:00.000Z",
      log: (line) => logs.push(line),
    });

    expect(result.sessionsClassified).toBe(0);
    expect(result.windowsFailed).toBe(1);
    expect(result.windowsClassified).toBe(0);
  });

  test("each chunk gets a fresh slice: chunk 2 sees chunk 1's activity and chunk 1's session note", async () => {
    const database = openDatabase(":memory:");
    seedHero(database);
    // Two chunks: more than throttleMinutes * 3 = 30 minutes apart so chunkByWindow
    // splits them, but less than activityIdleMinutes = 45 apart so chunk 1's activity
    // is still open when chunk 2 is classified.
    seedSession(database, {
      id: "s1",
      endedAt: "2026-09-04T15:40:00.000Z",
      messageTimestamps: ["2026-09-04T15:00:00.000Z", "2026-09-04T15:40:00.000Z"],
    });

    /** Records the slice each chunk was handed, and reuses whatever it is offered. */
    class SliceRecordingClassifier implements Classifier {
      public seen: {
        openActivities: string[];
        recentActivities: string[];
        previousSessionNote: string | null;
      }[] = [];

      async classify(window: ClassifierWindow): Promise<ClassifierResult> {
        this.seen.push({
          openActivities: window.sessionOpenActivities.map((a) => a.activityId),
          recentActivities: window.recentActivities.map((a) => a.activityId),
          previousSessionNote: window.previousSessionNote,
        });
        const open = window.sessionOpenActivities.at(-1) ?? null;
        const first = window.messages[0]?.ts ?? "2026-09-04T15:00:00.000Z";
        const last = window.messages.at(-1)?.ts ?? first;
        return {
          segments: [
            {
              startedAt: first,
              endedAt: last,
              what: "work",
              why: "ship",
              matchedQuest: null,
              proposedQuest: null,
              matchedActivity: open?.activityId ?? null,
              continuesActivity: null,
              newActivityReason: open === null ? "nothing open to reuse yet" : null,
              isSwitch: false,
              trigger: null,
              confidence: 0.9,
              questions: [],
            },
          ],
          sessionNote: `note from chunk ${this.seen.length}`,
        };
      }
    }

    const classifier = new SliceRecordingClassifier();
    const result = await backfill(database, makeConfig(), config, classifier, {
      days: 15,
      now: "2026-09-04T17:00:00.000Z",
      log: () => {},
    });

    expect(result.windowsClassified).toBe(2);
    expect(classifier.seen).toHaveLength(2);

    // Chunk 1 starts cold; chunk 2 must see what chunk 1 actually produced.
    expect(classifier.seen[0]?.openActivities).toEqual([]);
    expect(classifier.seen[0]?.previousSessionNote).toBeNull();

    const activity = database.query("SELECT id FROM activities").get() as { id: string };
    expect(classifier.seen[1]?.openActivities).toEqual([activity.id]);
    expect(classifier.seen[1]?.previousSessionNote).toBe("note from chunk 1");

    // Chunk 2 reused chunk 1's activity rather than opening a second one.
    const activityCount = database.query("SELECT COUNT(*) as count FROM activities").get() as {
      count: number;
    };
    expect(activityCount.count).toBe(1);

    // The last chunk's note is persisted for whatever runs next.
    const run = database
      .query("SELECT session_note FROM w5_runs WHERE session_id = 's1'")
      .get() as { session_note: string | null } | null;
    expect(run?.session_note).toBe("note from chunk 2");
  });

  test("force bypasses w5_windows coverage and reclassifies an already-covered window", async () => {
    const database = openDatabase(":memory:");
    seedHero(database);
    seedSession(database, { id: "s1", endedAt: "2026-09-04T15:20:00.000Z" });

    const classifier = new FakeClassifier();
    const logs: string[] = [];

    const firstResult = await backfill(database, makeConfig(), config, classifier, {
      days: 15,
      now: "2026-09-04T17:00:00.000Z",
      log: (line) => logs.push(line),
    });
    expect(firstResult.windowsClassified).toBe(1);

    const secondResult = await backfill(database, makeConfig(), config, classifier, {
      days: 15,
      now: "2026-09-04T17:00:00.000Z",
      log: (line) => logs.push(line),
      force: true,
    });

    expect(secondResult.windowsClassified).not.toBe(0);
    expect(secondResult.windowsSkipped).toBe(0);
  });

  test("to bounds each session's message window, not just the session query", async () => {
    const database = openDatabase(":memory:");
    seedHero(database);
    // Session's own ended_at sits strictly before `to` so it is selected by
    // the session query, but claude_messages (the source `buildWindow`
    // actually reads) has messages both before and after `to` -- e.g. from a
    // later resync of the same session file. The window fed to the
    // classifier must stop before `to`, not run to the session's actual last
    // message. `to` is an exclusive upper bound (see `eval.ts`'s
    // `normalizeEvalRange`), so it sits strictly after the messages meant to
    // be included and strictly before (or at) the one meant to be excluded.
    seedSession(database, {
      id: "s1",
      endedAt: "2026-09-04T15:09:00.000Z",
      messageTimestamps: [
        "2026-09-04T15:00:00.000Z",
        "2026-09-04T15:05:00.000Z",
        "2026-09-04T15:40:00.000Z",
      ],
    });

    const classifier = new FakeClassifier();
    const logs: string[] = [];

    await backfill(database, makeConfig(), config, classifier, {
      days: 15,
      now: "2026-09-04T17:00:00.000Z",
      log: (line) => logs.push(line),
      to: "2026-09-04T15:10:00.000Z",
    });

    const traces = database
      .query("SELECT started_at as startedAt, ended_at as endedAt FROM traces")
      .all() as { startedAt: string; endedAt: string }[];
    expect(traces.length).toBe(1);
    expect((traces[0] as { endedAt: string }).endedAt < "2026-09-04T15:10:00.000Z").toBe(true);
  });
});
