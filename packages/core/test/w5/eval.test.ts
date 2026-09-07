import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db/database";
import { applyIncremental, ensureTables } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";
import {
  type Classifier,
  type ClassifierResult,
  type ClassifierWindow,
  validateResult,
} from "../../src/w5/classifier";
import { InvalidDeclareFileError, InvalidEvalRangeError, runEval } from "../../src/w5/eval";

registerAllProjections();

class FakeClassifier implements Classifier {
  async classify(window: ClassifierWindow): Promise<ClassifierResult> {
    const first = window.messages[0]?.ts ?? "2026-09-01T10:00:00.000Z";
    const last = window.messages.at(-1)?.ts ?? first;
    return {
      segments: [
        {
          startedAt: first,
          endedAt: last,
          what: "work",
          why: "ship",
          belongs: true,
          guess: null,
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

function seedSourceDb(path: string): void {
  const database = openDatabase(path);
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
  database
    .query(
      `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES ('s1', '/c', 'p', '/c/p/s1.jsonl', '/w/p', 'personal', 'p', 'p session', 'main', '2026-09-01T10:00:00.000Z', '2026-09-01T10:30:00.000Z', 1, 0, '[]', 'host', '2026-09-01T10:30:00.000Z')`,
    )
    .run();
  database
    .query(
      `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
       VALUES ('m1', 's1', '2026-09-01T10:00:00.000Z', 'user', 0, 'do the thing')`,
    )
    .run();
  database.close();
}

describe("w5 eval", () => {
  test("copies the source db, force-reclassifies the range, and reports metrics without touching the source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-"));
    const sourcePath = join(dir, "source.db");
    seedSourceDb(sourcePath);
    const sourceBytesBefore = await Bun.file(sourcePath).arrayBuffer();

    const metrics = await runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-02T00:00:00.000Z",
      classifier: new FakeClassifier(),
      log: () => {},
    });

    expect(metrics.traces).toBe(1);
    expect(metrics.activities).toBe(1);
    expect(metrics.ratio).toBe(1);
    expect(metrics.continuesLinks).toBe(0);
    expect(metrics.doubts).toBe(0);
    expect(metrics.sample.length).toBe(1);
    expect(metrics.sample[0]).toMatchObject({
      what: "work",
      why: "ship",
      sessionTitle: "p session",
    });
    expect(metrics.copiedDbPath).not.toBe(sourcePath);

    const sourceBytesAfter = await Bun.file(sourcePath).arrayBuffer();
    expect(Buffer.from(sourceBytesAfter).equals(Buffer.from(sourceBytesBefore))).toBe(true);
  });

  test("never opens the source database for writing even when the eval range excludes all sessions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-empty-"));
    const sourcePath = join(dir, "source.db");
    seedSourceDb(sourcePath);
    const sourceBytesBefore = await Bun.file(sourcePath).arrayBuffer();

    const metrics = await runEval({
      from: "2026-01-01",
      to: "2026-01-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-01-02T00:00:00.000Z",
      classifier: new FakeClassifier(),
      log: () => {},
    });

    expect(metrics.traces).toBe(0);
    expect(metrics.activities).toBe(0);
    expect(metrics.ratio).toBe(0);
    expect(metrics.medianActivityDurationMinutes).toBe(0);
    expect(metrics.sample.length).toBe(0);

    const sourceBytesAfter = await Bun.file(sourcePath).arrayBuffer();
    expect(Buffer.from(sourceBytesAfter).equals(Buffer.from(sourceBytesBefore))).toBe(true);
  });

  test("rejects a malformed --from/--to before touching the source database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-bad-range-"));
    const sourcePath = join(dir, "source.db");
    seedSourceDb(sourcePath);

    await expect(
      runEval({
        from: "not-a-date",
        to: "2026-09-02",
        sourceDbPath: sourcePath,
        scratchDir: dir,
        now: "2026-09-02T00:00:00.000Z",
        classifier: new FakeClassifier(),
        log: () => {},
      }),
    ).rejects.toBeInstanceOf(InvalidEvalRangeError);

    await expect(
      runEval({
        from: "2026-09-02",
        to: "not-a-date",
        sourceDbPath: sourcePath,
        scratchDir: dir,
        now: "2026-09-02T00:00:00.000Z",
        classifier: new FakeClassifier(),
        log: () => {},
      }),
    ).rejects.toBeInstanceOf(InvalidEvalRangeError);

    await expect(
      runEval({
        from: "2026-09-05",
        to: "2026-09-01",
        sourceDbPath: sourcePath,
        scratchDir: dir,
        now: "2026-09-05T00:00:00.000Z",
        classifier: new FakeClassifier(),
        log: () => {},
      }),
    ).rejects.toBeInstanceOf(InvalidEvalRangeError);
  });

  test("copies committed rows even when the source db's WAL sidecar has not been checkpointed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-wal-"));
    const sourcePath = join(dir, "source.db");

    const database = openDatabase(sourcePath);
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
    database
      .query(
        `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES ('s1', '/c', 'p', '/c/p/s1.jsonl', '/w/p', 'personal', 'p', 'p session', 'main', '2026-09-01T10:00:00.000Z', '2026-09-01T10:30:00.000Z', 1, 0, '[]', 'host', '2026-09-01T10:30:00.000Z')`,
      )
      .run();
    database
      .query(
        `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
         VALUES ('m1', 's1', '2026-09-01T10:00:00.000Z', 'user', 0, 'do the thing')`,
      )
      .run();
    // Leave the source connection open (WAL mode, from openDatabase) rather than
    // closing/checkpointing it -- this is the state a real tempad.db is in while
    // `tempad w5 run` holds it open.

    const metrics = await runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-02T00:00:00.000Z",
      classifier: new FakeClassifier(),
      log: () => {},
    });

    database.close();

    expect(metrics.traces).toBe(1);
    expect(metrics.activities).toBe(1);
  });

  test("reports a real quest conflict count from the run summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-conflict-"));
    const sourcePath = join(dir, "source.db");

    const database = openDatabase(sourcePath);
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
    database
      .query(
        `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES ('s1', '/c', 'p', '/c/p/s1.jsonl', '/w/p', 'personal', 'p', 'p session', 'main', '2026-09-01T10:00:00.000Z', '2026-09-01T15:40:00.000Z', 1, 0, '[]', 'host', '2026-09-01T15:40:00.000Z')`,
      )
      .run();
    // Two message groups more than throttleMinutes*3 = 30 minutes apart, so
    // backfill splits them into two chunks classified one after another;
    // less than activityIdleMinutes = 45 apart, so chunk 1's activity is
    // still open when chunk 2 is classified.
    for (const [index, ts] of ["2026-09-01T10:00:00.000Z", "2026-09-01T10:40:00.000Z"].entries()) {
      database
        .query(
          `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
           VALUES (?, 's1', ?, 'user', 0, 'do the thing')`,
        )
        .run(`m${index}`, ts);
    }
    database.close();

    /**
     * Chunk 1 proposes a new quest for a new activity. Chunk 2 reuses that
     * activity via `matchedActivity` but names a *different, non-null*
     * `matchedQuest` -- `apply.ts` never reassigns a matched activity's quest,
     * so this is exactly a quest conflict, counted and returned in the run
     * summary. `matchedQuest: null` would instead mean "no opinion" and count
     * nothing; that case is covered by its own test below.
     */
    class ConflictingClassifier implements Classifier {
      private chunk = 0;

      async classify(window: ClassifierWindow): Promise<ClassifierResult> {
        this.chunk += 1;
        const first = window.messages[0]?.ts ?? "2026-09-01T10:00:00.000Z";
        const last = window.messages.at(-1)?.ts ?? first;

        if (this.chunk === 1) {
          return {
            segments: [
              {
                startedAt: first,
                endedAt: last,
                what: "work",
                why: "ship",
                belongs: true,
                guess: null,
                matchedQuest: null,
                proposedQuest: { title: "Q1", objective: "ship it", commitment: "personal" },
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

        const open = window.sessionOpenActivities.at(-1);
        return {
          segments: [
            {
              startedAt: first,
              endedAt: last,
              what: "more work",
              why: "ship",
              belongs: true,
              guess: null,
              matchedQuest: "Q-OTHER",
              proposedQuest: null,
              matchedActivity: open?.activityId ?? null,
              continuesActivity: null,
              newActivityReason: open ? null : "nothing open to reuse",
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

    const metrics = await runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-02T00:00:00.000Z",
      classifier: new ConflictingClassifier(),
      log: () => {},
    });

    expect(metrics.doubts).toBe(1);
  });

  test("matchedQuest null on a matched activity is no opinion, not a conflict", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-no-opinion-"));
    const sourcePath = join(dir, "source.db");

    const database = openDatabase(sourcePath);
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
    database
      .query(
        `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES ('s1', '/c', 'p', '/c/p/s1.jsonl', '/w/p', 'personal', 'p', 'p session', 'main', '2026-09-01T10:00:00.000Z', '2026-09-01T15:40:00.000Z', 1, 0, '[]', 'host', '2026-09-01T15:40:00.000Z')`,
      )
      .run();
    for (const [index, ts] of ["2026-09-01T10:00:00.000Z", "2026-09-01T10:40:00.000Z"].entries()) {
      database
        .query(
          `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
           VALUES (?, 's1', ?, 'user', 0, 'do the thing')`,
        )
        .run(`m${index}`, ts);
    }
    database.close();

    /** Same shape as the conflict case, but chunk 2 offers no quest opinion. */
    class SilentQuestClassifier implements Classifier {
      private chunk = 0;

      async classify(window: ClassifierWindow): Promise<ClassifierResult> {
        this.chunk += 1;
        const first = window.messages[0]?.ts ?? "2026-09-01T10:00:00.000Z";
        const last = window.messages.at(-1)?.ts ?? first;

        if (this.chunk === 1) {
          return {
            segments: [
              {
                startedAt: first,
                endedAt: last,
                what: "work",
                why: "ship",
                belongs: true,
                guess: null,
                matchedQuest: null,
                proposedQuest: { title: "Q1", objective: "ship it", commitment: "personal" },
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

        const open = window.sessionOpenActivities.at(-1);
        return {
          segments: [
            {
              startedAt: first,
              endedAt: last,
              what: "more work",
              why: "ship",
              belongs: true,
              guess: null,
              matchedQuest: null,
              proposedQuest: null,
              matchedActivity: open?.activityId ?? null,
              continuesActivity: null,
              newActivityReason: open ? null : "nothing open to reuse",
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

    const metrics = await runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-02T00:00:00.000Z",
      classifier: new SilentQuestClassifier(),
      log: () => {},
    });

    expect(metrics.doubts).toBe(0);
  });

  test("selector repairs are counted and surfaced in the metrics", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-selector-"));
    const sourcePath = join(dir, "source.db");

    const database = openDatabase(sourcePath);
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
    database
      .query(
        `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES ('s1', '/c', 'p', '/c/p/s1.jsonl', '/w/p', 'personal', 'p', 'p session', 'main', '2026-09-01T10:00:00.000Z', '2026-09-01T15:40:00.000Z', 1, 0, '[]', 'host', '2026-09-01T15:40:00.000Z')`,
      )
      .run();
    database
      .query(
        `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
         VALUES ('m0', 's1', '2026-09-01T10:00:00.000Z', 'user', 0, 'do the thing')`,
      )
      .run();
    database.close();

    /**
     * Returns raw JSON through `validateResult`, the way a real backend does, so
     * the repair happens where it would in production: a segment naming no
     * selector at all.
     */
    class SelectorlessClassifier implements Classifier {
      async classify(window: ClassifierWindow): Promise<ClassifierResult> {
        const first = window.messages[0]?.ts ?? "2026-09-01T10:00:00.000Z";
        const last = window.messages.at(-1)?.ts ?? first;
        return validateResult(
          {
            segments: [
              {
                startedAt: first,
                endedAt: last,
                what: "work",
                why: "ship",
                belongs: true,
                confidence: 0.9,
                isSwitch: false,
              },
            ],
            sessionNote: null,
          },
          window,
        );
      }
    }

    const metrics = await runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-02T00:00:00.000Z",
      classifier: new SelectorlessClassifier(),
      log: () => {},
    });

    expect(metrics.selectorDefaulted).toBe(1);
    expect(metrics.selectorAmbiguous).toBe(0);
    expect(metrics.traces).toBe(1);
  });

  test("resets an old cohort inside the range before rerunning, leaves rows outside the range untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-reset-"));
    const sourcePath = join(dir, "source.db");

    const database = openDatabase(sourcePath);
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
    applyIncremental(
      database,
      store.append({
        actor: "hook",
        kind: "quest.created",
        subject: "Q_IN",
        payload: {
          owner: { kind: "hero", id: "H1" },
          title: "old in-range quest",
          objective: "obj",
          commitment: "focused",
          confirmed: false,
        },
      }),
    );
    applyIncremental(
      database,
      store.append({
        actor: "hook",
        kind: "activity.opened",
        subject: "A_IN",
        payload: { objective: "old in-range work", quest: "Q_IN" },
        at: "2026-09-01T09:00:00.000Z",
      }),
    );
    applyIncremental(
      database,
      store.append({
        actor: "backfill",
        kind: "trace.recorded",
        subject: "T_IN",
        sessionId: "s1",
        payload: {
          activity: "A_IN",
          tool: "claude-code",
          place: "p",
          source: "session",
          started_at: "2026-09-01T09:00:00.000Z",
          ended_at: "2026-09-01T09:10:00.000Z",
          who: "hero",
          what: "old work",
          why: "old",
          where: "personal/p",
          how: "claude-code",
          confidence: 0.9,
          classified_by: "assistant",
        },
      }),
    );
    applyIncremental(
      database,
      store.append({
        actor: "hook",
        kind: "quest.created",
        subject: "Q_OUT",
        payload: {
          owner: { kind: "hero", id: "H1" },
          title: "old out-of-range quest",
          objective: "obj",
          commitment: "focused",
          confirmed: false,
        },
      }),
    );
    applyIncremental(
      database,
      store.append({
        actor: "hook",
        kind: "activity.opened",
        subject: "A_OUT",
        payload: { objective: "old out-of-range work", quest: "Q_OUT" },
        at: "2026-08-01T09:00:00.000Z",
      }),
    );
    applyIncremental(
      database,
      store.append({
        actor: "backfill",
        kind: "trace.recorded",
        subject: "T_OUT",
        sessionId: "s2",
        payload: {
          activity: "A_OUT",
          tool: "claude-code",
          place: "p",
          source: "session",
          started_at: "2026-08-01T09:00:00.000Z",
          ended_at: "2026-08-01T09:10:00.000Z",
          who: "hero",
          what: "old work",
          why: "old",
          where: "personal/p",
          how: "claude-code",
          confidence: 0.9,
          classified_by: "assistant",
        },
      }),
    );
    database
      .query(
        `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES ('s1', '/c', 'p', '/c/p/s1.jsonl', '/w/p', 'personal', 'p', 'p session', 'main', '2026-09-01T10:00:00.000Z', '2026-09-01T10:30:00.000Z', 1, 0, '[]', 'host', '2026-09-01T10:30:00.000Z')`,
      )
      .run();
    database
      .query(
        `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
         VALUES ('m1', 's1', '2026-09-01T10:00:00.000Z', 'user', 0, 'do the thing')`,
      )
      .run();
    database
      .query(
        "INSERT INTO w5_runs (session_id, last_run_at, last_message_ts, session_note) VALUES ('s1', '2026-09-01T09:10:00.000Z', '2026-09-01T09:10:00.000Z', 'touched note')",
      )
      .run();
    database
      .query(
        "INSERT INTO w5_runs (session_id, last_run_at, last_message_ts, session_note) VALUES ('s2', '2026-08-01T09:10:00.000Z', '2026-08-01T09:10:00.000Z', 'untouched note')",
      )
      .run();
    database
      .query(
        "INSERT INTO w5_windows (session_id, started_at, ended_at, classified_at) VALUES ('s1', '2026-09-01T09:00:00.000Z', '2026-09-01T09:10:00.000Z', '2026-09-01T09:10:00.000Z')",
      )
      .run();
    database
      .query(
        "INSERT INTO w5_windows (session_id, started_at, ended_at, classified_at) VALUES ('s2', '2026-08-01T09:00:00.000Z', '2026-08-01T09:10:00.000Z', '2026-08-01T09:10:00.000Z')",
      )
      .run();
    database.close();

    const sourceBytesBefore = await Bun.file(sourcePath).arrayBuffer();

    const metrics = await runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-02T00:00:00.000Z",
      classifier: new FakeClassifier(),
      log: () => {},
    });

    const sourceBytesAfter = await Bun.file(sourcePath).arrayBuffer();
    expect(Buffer.from(sourceBytesAfter).equals(Buffer.from(sourceBytesBefore))).toBe(true);

    expect(metrics.resetTraces).toBe(1);
    expect(metrics.resetActivities).toBe(1);
    expect(metrics.resetQuests).toBe(1);

    const copied = openDatabase(metrics.copiedDbPath);
    const inRange = copied.query("SELECT retracted_at FROM traces WHERE id = 'T_IN'").get() as {
      retracted_at: string | null;
    };
    expect(inRange.retracted_at).not.toBeNull();
    const outOfRange = copied.query("SELECT retracted_at FROM traces WHERE id = 'T_OUT'").get() as {
      retracted_at: string | null;
    };
    expect(outOfRange.retracted_at).toBeNull();

    const questIn = copied.query("SELECT retracted_at FROM quests WHERE id = 'Q_IN'").get() as {
      retracted_at: string | null;
    };
    expect(questIn.retracted_at).not.toBeNull();
    const questOut = copied.query("SELECT retracted_at FROM quests WHERE id = 'Q_OUT'").get() as {
      retracted_at: string | null;
    };
    expect(questOut.retracted_at).toBeNull();

    const runS1 = copied
      .query("SELECT session_note FROM w5_runs WHERE session_id = 's1'")
      .get() as { session_note: string | null };
    expect(runS1.session_note).toBeNull();
    const runS2 = copied
      .query("SELECT session_note FROM w5_runs WHERE session_id = 's2'")
      .get() as { session_note: string | null };
    expect(runS2.session_note).toBe("untouched note");

    // The old w5_windows row for s1 (classified_at "2026-09-01T09:10:00.000Z") is
    // deleted by the reset; the rerun's backfill then inserts its own fresh row for
    // s1, so the reset's deletion is checked by that old row's absence, not by count.
    const oldWindowS1 = copied
      .query(
        "SELECT COUNT(*) as n FROM w5_windows WHERE session_id = 's1' AND classified_at = '2026-09-01T09:10:00.000Z'",
      )
      .get() as { n: number };
    expect(oldWindowS1.n).toBe(0);
    const windowsS2 = copied
      .query("SELECT COUNT(*) as n FROM w5_windows WHERE session_id = 's2'")
      .get() as { n: number };
    expect(windowsS2.n).toBe(1);

    copied.close();

    // Only the rerun's rows count toward the metrics, not the reset old cohort.
    expect(metrics.traces).toBe(1);
    expect(metrics.activities).toBe(1);
  });

  test("a bare --to date includes the whole to day, not just its start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-to-day-"));
    const sourcePath = join(dir, "source.db");

    const database = openDatabase(sourcePath);
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
    // Old cohort dated later in the day of --to (2026-09-02) -- a bare
    // "2026-09-02" upper bound compared as TEXT with `<=` against this
    // timestamp would previously evaluate false, leaving this old cohort
    // out of the reset entirely.
    applyIncremental(
      database,
      store.append({
        actor: "hook",
        kind: "activity.opened",
        subject: "A_LATE",
        payload: { objective: "old late-in-day work" },
        at: "2026-09-02T09:00:00.000Z",
      }),
    );
    applyIncremental(
      database,
      store.append({
        actor: "backfill",
        kind: "trace.recorded",
        subject: "T_LATE",
        sessionId: "s1",
        payload: {
          activity: "A_LATE",
          tool: "claude-code",
          place: "p",
          source: "session",
          started_at: "2026-09-02T09:00:00.000Z",
          ended_at: "2026-09-02T09:10:00.000Z",
          who: "hero",
          what: "old work",
          why: "old",
          where: "personal/p",
          how: "claude-code",
          confidence: 0.9,
          classified_by: "assistant",
        },
      }),
    );
    database
      .query(
        `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES ('s1', '/c', 'p', '/c/p/s1.jsonl', '/w/p', 'personal', 'p', 'p session', 'main', '2026-09-02T09:00:00.000Z', '2026-09-02T09:30:00.000Z', 1, 0, '[]', 'host', '2026-09-02T09:30:00.000Z')`,
      )
      .run();
    database
      .query(
        `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
         VALUES ('m1', 's1', '2026-09-02T09:00:00.000Z', 'user', 0, 'do the thing')`,
      )
      .run();
    database.close();

    const metrics = await runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-03T00:00:00.000Z",
      classifier: new FakeClassifier(),
      log: () => {},
    });

    // The late-in-day old cohort was reset and its trace's window reclassified.
    expect(metrics.resetTraces).toBe(1);
    expect(metrics.resetActivities).toBe(1);
    expect(metrics.traces).toBe(1);
    expect(metrics.activities).toBe(1);

    const copied = openDatabase(metrics.copiedDbPath);
    const oldTrace = copied.query("SELECT retracted_at FROM traces WHERE id = 'T_LATE'").get() as {
      retracted_at: string | null;
    };
    expect(oldTrace.retracted_at).not.toBeNull();
    copied.close();
  });

  test("--declare applies declarations to the copy before rerunning, producing doubts/doubtsAnswered/tracesUnattributed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-declare-"));
    const sourcePath = join(dir, "source.db");
    seedSourceDb(sourcePath);
    const declareFile = join(dir, "declare.json");
    writeFileSync(
      declareFile,
      JSON.stringify([
        {
          session_id: "s1",
          at: "2026-09-01T09:00:00.000Z",
          new: { title: "Ship p", objective: "ship it", commitment: "personal" },
        },
      ]),
    );

    const metrics = await runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-02T00:00:00.000Z",
      classifier: new FakeClassifier(),
      log: () => {},
      declareFile,
    });

    expect(metrics.doubts).toBeDefined();
    expect(metrics.doubtsAnswered).toBe(0);
    expect(metrics.tracesUnattributed).toBe(0);

    const copied = openDatabase(metrics.copiedDbPath);
    const quest = copied
      .query("SELECT title, origin_kind as originKind FROM quests WHERE title = 'Ship p'")
      .get() as { title: string; originKind: string } | null;
    expect(quest).not.toBeNull();
    expect(quest?.originKind).toBe("declared");
    copied.close();
  });

  test("doubtsAnswered excludes an answered belongs/declare question sitting on a retracted trace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-doubts-retracted-"));
    const sourcePath = join(dir, "source.db");
    const database = openDatabase(sourcePath);
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
    database
      .query(
        `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES ('s1', '/c', 'p', '/c/p/s1.jsonl', '/w/p', 'personal', 'p', 'p session', 'main', '2026-09-01T10:00:00.000Z', '2026-09-01T10:30:00.000Z', 1, 0, '[]', 'host', '2026-09-01T10:30:00.000Z')`,
      )
      .run();
    database
      .query(
        `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
         VALUES ('m1', 's1', '2026-09-01T10:00:00.000Z', 'user', 0, 'do the thing')`,
      )
      .run();
    // A pre-existing activity/trace/answered-belongs-question from an earlier
    // eval/backfill run of this same range -- resetRange (via runEval below)
    // retracts this trace as old-cohort, and doubtsAnswered must not count
    // its question once the trace it's tied to is gone.
    database.exec(
      `INSERT INTO activities (id, quest_id, objective, opened_at, closed_at, outcome, revision)
       VALUES ('activity-old', NULL, 'old work', '2026-09-01T10:00:00.000Z', '2026-09-01T10:10:00.000Z', NULL, 1)`,
    );
    database.exec(
      `INSERT INTO traces (id, activity_id, tool, place, source, source_ref, started_at, ended_at, who, what, why, where_text, how, confidence, classified_by, session_id, recorded_at)
       VALUES ('trace-old', 'activity-old', 'edit', '/w/p', 'session', 's1', '2026-09-01T10:00:00.000Z', '2026-09-01T10:10:00.000Z', 'H1', 'old edit', 'old reason', '/w/p', 'assistant edit', 0.9, 'model', 's1', '2026-09-01T10:10:00.000Z')`,
    );
    database.exec(
      `INSERT INTO questions (id, trace_id, session_id, text, kind, state, asked_at, answered_at, answer, answered_by, turns_watched)
       VALUES ('question-old', 'trace-old', 's1', 'does this belong?', 'belongs', 'answered', '2026-09-01T10:05:00.000Z', '2026-09-01T10:06:00.000Z', 'yes', 'hero', 1)`,
    );
    database.close();

    const metrics = await runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-02T00:00:00.000Z",
      classifier: new FakeClassifier(),
      log: () => {},
    });

    expect(metrics.resetTraces).toBeGreaterThan(0);
    expect(metrics.doubtsAnswered).toBe(0);
  });

  test("--declare leaves traces unattributed when the session never declares in that window", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-undeclared-"));
    const sourcePath = join(dir, "source.db");
    seedSourceDb(sourcePath);

    const metrics = await runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-02T00:00:00.000Z",
      classifier: new FakeClassifier(),
      log: () => {},
    });

    expect(metrics.tracesUnattributed).toBeGreaterThan(0);
  });

  test("a missing --declare file exits with InvalidDeclareFileError, not a raw crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-declare-missing-"));
    const sourcePath = join(dir, "source.db");
    seedSourceDb(sourcePath);

    await expect(
      runEval({
        from: "2026-09-01",
        to: "2026-09-02",
        sourceDbPath: sourcePath,
        scratchDir: dir,
        now: "2026-09-02T00:00:00.000Z",
        classifier: new FakeClassifier(),
        log: () => {},
        declareFile: join(dir, "does-not-exist.json"),
      }),
    ).rejects.toBeInstanceOf(InvalidDeclareFileError);
  });

  test("a malformed --declare file (bad JSON, or a non-array top level) exits with InvalidDeclareFileError", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-declare-malformed-"));
    const sourcePath = join(dir, "source.db");
    seedSourceDb(sourcePath);

    const badJsonFile = join(dir, "bad.json");
    writeFileSync(badJsonFile, "{ not valid json ]");

    await expect(
      runEval({
        from: "2026-09-01",
        to: "2026-09-02",
        sourceDbPath: sourcePath,
        scratchDir: dir,
        now: "2026-09-02T00:00:00.000Z",
        classifier: new FakeClassifier(),
        log: () => {},
        declareFile: badJsonFile,
      }),
    ).rejects.toBeInstanceOf(InvalidDeclareFileError);

    const notArrayFile = join(dir, "not-array.json");
    writeFileSync(notArrayFile, JSON.stringify({ session_id: "s1" }));

    await expect(
      runEval({
        from: "2026-09-01",
        to: "2026-09-02",
        sourceDbPath: sourcePath,
        scratchDir: dir,
        now: "2026-09-02T00:00:01.000Z",
        classifier: new FakeClassifier(),
        log: () => {},
        declareFile: notArrayFile,
      }),
    ).rejects.toBeInstanceOf(InvalidDeclareFileError);
  });

  test("a declaration for a session absent from the copy is logged and counted in declarationsSkipped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-declare-unknown-session-"));
    const sourcePath = join(dir, "source.db");
    seedSourceDb(sourcePath);
    const declareFile = join(dir, "declare.json");
    writeFileSync(
      declareFile,
      JSON.stringify([
        {
          session_id: "does-not-exist",
          at: "2026-09-01T09:00:00.000Z",
          new: { title: "Ship p", objective: "ship it", commitment: "personal" },
        },
      ]),
    );

    const lines: string[] = [];
    const metrics = await runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-02T00:00:00.000Z",
      classifier: new FakeClassifier(),
      log: (line) => lines.push(line),
      declareFile,
    });

    expect(metrics.declarationsSkipped).toBe(1);
    expect(lines.some((line) => line.includes("does-not-exist"))).toBe(true);
  });

  test("attributeNonClaudeEvidence's tie rule ('latest declaration wins') applies through --declare when two sessions overlap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-tie-"));
    const sourcePath = join(dir, "source.db");
    const database = openDatabase(sourcePath);
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
    database
      .query(
        `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, title, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES
         ('s-early', '/c', 'p', '/c/p/s-early.jsonl', '/w/p', 'personal', 'p', 'early', 'main', '2026-09-01T09:00:00.000Z', '2026-09-01T12:00:00.000Z', 1, 0, '[]', 'host', '2026-09-01T12:00:00.000Z'),
         ('s-late', '/c', 'p', '/c/p/s-late.jsonl', '/w/p', 'personal', 'p', 'late', 'main', '2026-09-01T10:00:00.000Z', '2026-09-01T12:00:00.000Z', 1, 0, '[]', 'host', '2026-09-01T12:00:00.000Z')`,
      )
      .run();
    database
      .query(
        `INSERT INTO claude_messages (uuid, session_id, ts, role, is_sidechain, text_preview)
         VALUES ('m1', 's-early', '2026-09-01T09:00:00.000Z', 'user', 0, 'do the thing')`,
      )
      .run();
    database.close();

    const declareFile = join(dir, "declare.json");
    writeFileSync(
      declareFile,
      JSON.stringify([
        {
          session_id: "s-early",
          at: "2026-09-01T09:00:00.000Z",
          new: { title: "Early quest", objective: "early", commitment: "personal" },
        },
        {
          session_id: "s-late",
          at: "2026-09-01T10:00:00.000Z",
          new: { title: "Late quest", objective: "late", commitment: "personal" },
        },
      ]),
    );

    const metrics = await runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-02T00:00:00.000Z",
      classifier: new FakeClassifier(),
      log: () => {},
      declareFile,
    });

    const { attributeNonClaudeEvidence } = await import("../../src/report/intent-queries");
    const copied = openDatabase(metrics.copiedDbPath);
    copied
      .query(
        `INSERT INTO gh_repos (full_name, org, is_personal, project) VALUES ('personal/p', 'personal', 1, 'p')`,
      )
      .run();
    copied
      .query(
        `INSERT INTO gh_commits (sha, repo, branches, author_name, author_email, authored_at, committed_at, subject, files_changed, insertions, deletions)
         VALUES ('cccccccc0000000000000000000000000000000', 'personal/p', '["main"]', 'A', 'a@example.com', '2026-09-01T11:00:00.000Z', '2026-09-01T11:00:00.000Z', 'tie test', 1, 1, 1)`,
      )
      .run();

    const rows = attributeNonClaudeEvidence(copied, {
      from: "2026-09-01",
      to: "2026-09-02",
      timeZone: "UTC",
    });
    const row = rows.find((r) => r.id === "cccccccc0000000000000000000000000000000");
    expect(row?.questTitle).toBe("Late quest");
    copied.close();
  });

  test("--declare passes through scope/parent_session_id/declared_by, and resolves new_ref/quest_ref across entries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-refs-"));
    const sourcePath = join(dir, "source.db");
    seedSourceDb(sourcePath);
    const declareFile = join(dir, "declare.json");
    writeFileSync(
      declareFile,
      JSON.stringify([
        {
          session_id: "s1",
          at: "2026-09-01T09:00:00.000Z",
          new: { title: "Ship p", objective: "ship it", commitment: "personal" },
          new_ref: "main-quest",
        },
        {
          session_id: "s1-sub",
          at: "2026-09-01T09:05:00.000Z",
          quest_ref: "main-quest",
          scope: "subagent",
          parent_session_id: "s1",
          declared_by: "agent",
        },
      ]),
    );

    const metrics = await runEval({
      from: "2026-09-01",
      to: "2026-09-02",
      sourceDbPath: sourcePath,
      scratchDir: dir,
      now: "2026-09-02T00:00:00.000Z",
      classifier: new FakeClassifier(),
      log: () => {},
      declareFile,
    });

    const { currentDeclaredQuestForSubagent } = await import("../../src/intent/declarations");
    const copied = openDatabase(metrics.copiedDbPath);
    const declared = currentDeclaredQuestForSubagent(copied, {
      sessionId: "s1-sub",
      parentSessionId: "s1",
      at: "2026-09-01T09:10:00.000Z",
    });
    expect(declared?.title).toBe("Ship p");
    copied.close();
  });

  test("--declare rejects an unknown quest_ref with InvalidDeclareFileError", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-refs-unknown-"));
    const sourcePath = join(dir, "source.db");
    seedSourceDb(sourcePath);
    const declareFile = join(dir, "declare.json");
    writeFileSync(
      declareFile,
      JSON.stringify([
        {
          session_id: "s1",
          at: "2026-09-01T09:00:00.000Z",
          quest_ref: "does-not-exist",
        },
      ]),
    );

    await expect(
      runEval({
        from: "2026-09-01",
        to: "2026-09-02",
        sourceDbPath: sourcePath,
        scratchDir: dir,
        now: "2026-09-02T00:00:00.000Z",
        classifier: new FakeClassifier(),
        log: () => {},
        declareFile,
      }),
    ).rejects.toBeInstanceOf(InvalidDeclareFileError);
  });

  test("--declare rejects an entry with none of quest/quest_ref/new", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-refs-none-"));
    const sourcePath = join(dir, "source.db");
    seedSourceDb(sourcePath);
    const declareFile = join(dir, "declare.json");
    writeFileSync(
      declareFile,
      JSON.stringify([{ session_id: "s1", at: "2026-09-01T09:00:00.000Z" }]),
    );

    await expect(
      runEval({
        from: "2026-09-01",
        to: "2026-09-02",
        sourceDbPath: sourcePath,
        scratchDir: dir,
        now: "2026-09-02T00:00:00.000Z",
        classifier: new FakeClassifier(),
        log: () => {},
        declareFile,
      }),
    ).rejects.toBeInstanceOf(InvalidDeclareFileError);
  });

  test("--declare rejects an entry with more than one of quest/quest_ref/new", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-refs-multiple-"));
    const sourcePath = join(dir, "source.db");
    seedSourceDb(sourcePath);
    const declareFile = join(dir, "declare.json");
    writeFileSync(
      declareFile,
      JSON.stringify([
        {
          session_id: "s1",
          at: "2026-09-01T09:00:00.000Z",
          quest: "some-quest-id",
          new: { title: "Ship p", objective: "ship it", commitment: "personal" },
        },
      ]),
    );

    await expect(
      runEval({
        from: "2026-09-01",
        to: "2026-09-02",
        sourceDbPath: sourcePath,
        scratchDir: dir,
        now: "2026-09-02T00:00:00.000Z",
        classifier: new FakeClassifier(),
        log: () => {},
        declareFile,
      }),
    ).rejects.toBeInstanceOf(InvalidDeclareFileError);
  });

  test("--declare rejects new_ref given without new", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-eval-refs-orphan-newref-"));
    const sourcePath = join(dir, "source.db");
    seedSourceDb(sourcePath);
    const declareFile = join(dir, "declare.json");
    writeFileSync(
      declareFile,
      JSON.stringify([
        {
          session_id: "s1",
          at: "2026-09-01T09:00:00.000Z",
          quest: "some-quest-id",
          new_ref: "orphan",
        },
      ]),
    );

    await expect(
      runEval({
        from: "2026-09-01",
        to: "2026-09-02",
        sourceDbPath: sourcePath,
        scratchDir: dir,
        now: "2026-09-02T00:00:00.000Z",
        classifier: new FakeClassifier(),
        log: () => {},
        declareFile,
      }),
    ).rejects.toBeInstanceOf(InvalidDeclareFileError);
  });
});
