import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db/database.ts";
import { openActivity } from "../../src/intent/api.ts";
import { EventStore } from "../../src/intent/store.ts";

// Regression test: intent/cli.ts registers all projections on startup, but a
// caller reaching intent/api.ts directly (never importing cli.ts) used to get
// silent no-op projections -- the event was appended but no `activities` row
// was ever materialized. api.ts now registers projections itself on import.
describe("intent/api without intent/cli", () => {
  test("openActivity materializes an activities row", () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-api-projections-test-"));
    const database = openDatabase(join(dir, "tempad.db"));
    const store = new EventStore(database);

    const id = openActivity(store, database, {
      objective: "test activity",
      actor: "hero",
    });

    const row = database.query("SELECT id, objective FROM activities WHERE id = ?").get(id) as {
      id: string;
      objective: string;
    } | null;

    expect(row).not.toBeNull();
    expect(row?.objective).toBe("test activity");

    database.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
