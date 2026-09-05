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
    completeJob(database, job?.id ?? 0, "2026-09-05T10:01:30.000Z");
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
    completeJob(database, job?.id ?? 0, null);
    expect(isThrottled(database, "s3", "2026-09-05T10:05:00.000Z", 10)).toBe(true);
    expect(isThrottled(database, "s3", "2026-09-05T10:15:00.000Z", 10)).toBe(false);
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
