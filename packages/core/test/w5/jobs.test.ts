import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import { claimNextJob, completeJob, enqueueJob, failJob, isThrottled } from "../../src/w5/jobs";

describe("w5 jobs", () => {
  test("enqueue, throttle, duplicate upgrade, claim, complete", () => {
    const database = openDatabase(":memory:");
    expect(
      enqueueJob(database, {
        sessionId: "s1",
        forced: false,
        now: "2026-09-05T10:00:00.000Z",
        throttleMinutes: 10,
      }).enqueued,
    ).toBe(true);
    expect(
      enqueueJob(database, {
        sessionId: "s1",
        forced: false,
        now: "2026-09-05T10:01:00.000Z",
        throttleMinutes: 10,
      }),
    ).toEqual({ enqueued: false, reason: "duplicate" });
    expect(
      enqueueJob(database, {
        sessionId: "s1",
        forced: true,
        now: "2026-09-05T10:01:00.000Z",
        throttleMinutes: 10,
      }),
    ).toEqual({ enqueued: false, reason: "duplicate" });
    expect((database.query("SELECT forced FROM w5_jobs").get() as { forced: number }).forced).toBe(
      1,
    );
    const job = claimNextJob(database, "2026-09-05T10:02:00.000Z");
    expect(job?.sessionId).toBe("s1");
    expect(claimNextJob(database)).toBeNull();
    completeJob(database, job?.id ?? 0, "2026-09-05T10:01:30.000Z", "2026-09-05T10:02:00.000Z");
    expect(
      enqueueJob(database, {
        sessionId: "s1",
        forced: false,
        now: "2026-09-05T10:05:00.000Z",
        throttleMinutes: 10,
      }),
    ).toEqual({ enqueued: false, reason: "throttled" });
    expect(
      enqueueJob(database, {
        sessionId: "s1",
        forced: true,
        now: "2026-09-05T10:05:00.000Z",
        throttleMinutes: 10,
      }).enqueued,
    ).toBe(true);
    expect(
      enqueueJob(database, {
        sessionId: "s1",
        forced: false,
        now: "2026-09-05T10:13:00.000Z",
        throttleMinutes: 10,
      }).enqueued,
    ).toBe(false);
  });

  test("isThrottled reflects w5_runs.last_run_at directly", () => {
    const database = openDatabase(":memory:");
    expect(isThrottled(database, "s3", "2026-09-05T10:00:00.000Z", 10)).toBe(false);
    enqueueJob(database, {
      sessionId: "s3",
      forced: true,
      now: "2026-09-05T10:00:00.000Z",
      throttleMinutes: 10,
    });
    const job = claimNextJob(database, "2026-09-05T10:00:00.000Z");
    completeJob(database, job?.id ?? 0, null, "2026-09-05T10:00:00.000Z");
    expect(isThrottled(database, "s3", "2026-09-05T10:05:00.000Z", 10)).toBe(true);
    expect(isThrottled(database, "s3", "2026-09-05T10:15:00.000Z", 10)).toBe(false);
  });

  test("completeJob records last_run_at as the actual completion time, not claimed_at", () => {
    const database = openDatabase(":memory:");
    enqueueJob(database, {
      sessionId: "s4",
      forced: true,
      now: "2026-09-05T10:00:00.000Z",
      throttleMinutes: 10,
    });
    // Claimed early, but the run takes a while to actually finish.
    const job = claimNextJob(database, "2026-09-05T10:00:00.000Z");
    completeJob(database, job?.id ?? 0, null, "2026-09-05T10:20:00.000Z");

    const run = database.query("SELECT last_run_at FROM w5_runs WHERE session_id = 's4'").get() as {
      last_run_at: string;
    };
    expect(run.last_run_at).toBe("2026-09-05T10:20:00.000Z");
    expect(run.last_run_at).not.toBe("2026-09-05T10:00:00.000Z");

    // Throttle window is measured from the real completion time (10:20), not claimed_at (10:00):
    // 5 minutes after completion is still within a 10-minute throttle.
    expect(isThrottled(database, "s4", "2026-09-05T10:25:00.000Z", 10)).toBe(true);
    // Whereas 5 minutes after claimed_at would have already cleared a 10-min throttle
    // under the old (buggy) behavior — confirming we're using completion time, not claim time.
    expect(isThrottled(database, "s4", "2026-09-05T10:05:00.000Z", 10)).toBe(true);
  });

  test("completeJob defaults now to the current time when omitted", () => {
    const database = openDatabase(":memory:");
    enqueueJob(database, {
      sessionId: "s5",
      forced: true,
      now: "2026-09-05T10:00:00.000Z",
      throttleMinutes: 10,
    });
    const job = claimNextJob(database, "2026-09-05T10:00:00.000Z");
    const before = Date.now();
    completeJob(database, job?.id ?? 0, null);
    const after = Date.now();

    const run = database.query("SELECT last_run_at FROM w5_runs WHERE session_id = 's5'").get() as {
      last_run_at: string;
    };
    const recordedMs = Date.parse(run.last_run_at);
    expect(recordedMs).toBeGreaterThanOrEqual(before);
    expect(recordedMs).toBeLessThanOrEqual(after);
  });

  test("enqueueJob stores kind, defaulting to classify, and upgrades kind on duplicate", () => {
    const database = openDatabase(":memory:");
    enqueueJob(database, {
      sessionId: "s3",
      forced: false,
      now: "2026-09-06T10:00:00.000Z",
      throttleMinutes: 10,
    });
    expect(
      (database.query("SELECT kind FROM w5_jobs WHERE session_id = 's3'").get() as { kind: string })
        .kind,
    ).toBe("classify");

    enqueueJob(database, {
      sessionId: "s3",
      forced: true,
      kind: "session_end",
      now: "2026-09-06T10:01:00.000Z",
      throttleMinutes: 10,
    });
    const row = database
      .query("SELECT kind, forced FROM w5_jobs WHERE session_id = 's3'")
      .get() as {
      kind: string;
      forced: number;
    };
    expect(row).toEqual({ kind: "session_end", forced: 1 });

    const job = claimNextJob(database, "2026-09-06T10:02:00.000Z");
    expect(job?.kind).toBe("session_end");
  });

  test("enqueueJob never downgrades a queued session_end job back to classify", () => {
    const database = openDatabase(":memory:");
    enqueueJob(database, {
      sessionId: "s6",
      forced: true,
      kind: "session_end",
      now: "2026-09-06T10:00:00.000Z",
      throttleMinutes: 10,
    });

    // A Stop racing in behind the SessionEnd must not downgrade the job.
    enqueueJob(database, {
      sessionId: "s6",
      forced: false,
      kind: "classify",
      now: "2026-09-06T10:00:30.000Z",
      throttleMinutes: 10,
    });

    expect(
      (database.query("SELECT kind FROM w5_jobs WHERE session_id = 's6'").get() as { kind: string })
        .kind,
    ).toBe("session_end");
  });

  test("failJob records the error and frees the queue", () => {
    const database = openDatabase(":memory:");
    enqueueJob(database, { sessionId: "s2", forced: true, throttleMinutes: 10 });
    const job = claimNextJob(database);
    failJob(database, job?.id ?? 0, "boom");
    expect(
      (database.query("SELECT state, error FROM w5_jobs").get() as { state: string; error: string })
        .state,
    ).toBe("failed");
  });
});
