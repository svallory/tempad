import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db/database";
import { applyIncremental, ensureTables } from "../../src/intent/projections";
import { registerAllProjections } from "../../src/intent/projections/register";
import { EventStore } from "../../src/intent/store";
import type { Classifier, ClassifierResult, ClassifierWindow } from "../../src/w5/classifier";
import { InvalidEvalRangeError, runEval } from "../../src/w5/eval";

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
    expect(metrics.questConflicts).toBe(0);
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
     * activity via `matchedActivity` but names a different `matchedQuest`
     * (`null`, the activity's real quest is non-null) -- `apply.ts` never
     * reassigns a matched activity's quest, so this is exactly a quest
     * conflict, counted and returned in the run summary.
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
      classifier: new ConflictingClassifier(),
      log: () => {},
    });

    expect(metrics.questConflicts).toBe(1);
  });
});
