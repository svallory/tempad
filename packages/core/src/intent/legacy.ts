/**
 * Translation from the pre-2026-09-07 vocabulary to the current one.
 *
 * Events are append-only: the database still holds rows written with the old
 * kinds (`activity.opened`, `goal.created`) and the old payload field names
 * (`objective`, `activity`, `goal`). Rather than rewrite history, every row is
 * translated once as it is decoded, at the single read boundary in `store.ts`.
 * Everything above that boundary -- projections, reports, the CLI -- only ever
 * sees the new names, and every event written from now on is written with them.
 *
 * See docs/specs/2026-09-07-ubiquitous-language.md.
 */

/** Old event kind -> current event kind. */
export const LEGACY_EVENT_KINDS: Readonly<Record<string, string>> = {
  "activity.opened": "stint.opened",
  "activity.reworded": "stint.reworded",
  "activity.closed": "stint.closed",
  "activity.assigned": "stint.assigned",
  "goal.created": "saga.created",
  "goal.reworded": "saga.reworded",
  "goal.ended": "saga.ended",
};

/** Current event kind -> the old kinds that decode to it. */
const CURRENT_TO_LEGACY_KINDS: Readonly<Record<string, string[]>> = (() => {
  const byCurrent: Record<string, string[]> = {};
  for (const [legacy, current] of Object.entries(LEGACY_EVENT_KINDS)) {
    const existing = byCurrent[current];
    if (existing) existing.push(legacy);
    else byCurrent[current] = [legacy];
  }
  return byCurrent;
})();

/**
 * Every raw `events.kind` value that decodes to `kind`, itself included.
 *
 * A caller filtering by kind means the decoded name, but the column holds the
 * name as written, so a `kind = ?` comparison would miss all of history. Read
 * paths must match against this set instead.
 */
export function rawKindsFor(kind: string): string[] {
  return [kind, ...(CURRENT_TO_LEGACY_KINDS[kind] ?? [])];
}

/**
 * Old payload field -> current payload field, **scoped to the kinds that
 * actually wrote the old field**.
 *
 * Scoping matters because these are ordinary words: a future payload could
 * legitimately carry a top-level `origin` or `parent` meaning something else
 * entirely, and a global rename would silently corrupt it. Each entry below is
 * keyed by the decoded (current) kind, and was verified against both `main`'s
 * writers and the real event log before being listed.
 *
 * Deliberately absent:
 * - `goal_id`: no kind ever wrote it as a payload field. It was only ever a
 *   *column* name (`quests.goal_id`), renamed by migration 0011.
 * - `origin`: only ever written nested inside `quest.declared`'s `new` object,
 *   never top-level, and that object is re-derived from the `quests`
 *   projection rather than read back from the payload.
 * - `parent`: never written in the quest-relation sense. The only historical
 *   `parent` is the `--parent <session-id>` CLI flag, stored under the
 *   distinct and still-current name `parent_session_id`.
 */
export const LEGACY_PAYLOAD_FIELDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "stint.opened": { objective: "outcome" },
  "stint.reworded": { objective: "outcome" },
  "quest.created": { objective: "outcome", goal: "serves" },
  "quest.reworded": { objective: "outcome" },
  "quest.branched": { from_activity: "deviates_from" },
  "trace.recorded": { activity: "stint" },
  "trace.relinked": { activity: "stint" },
};

export function translateLegacyKind(kind: string): string {
  return LEGACY_EVENT_KINDS[kind] ?? kind;
}

/**
 * Renames this kind's known legacy fields on one payload. A payload that
 * already uses the current name keeps it: the current name always wins, so
 * re-reading an event written after the rename is a no-op.
 *
 * `kind` is the **decoded** kind, as returned by `translateLegacyKind`.
 */
export function translateLegacyPayload(
  kind: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const fields = LEGACY_PAYLOAD_FIELDS[kind];
  if (!fields) return payload;

  const translated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    const renamed = fields[key] ?? key;
    if (renamed !== key && renamed in payload) {
      // The event already carries the current name; drop the stale alias.
      continue;
    }
    translated[renamed] = value;
  }
  return translated;
}
