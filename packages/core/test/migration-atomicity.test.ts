import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/db/migrations");
const EXTRA = join(MIGRATIONS_DIR, "9999_atomicity_probe.sql");

afterEach(() => {
  rmSync(EXTRA, { force: true });
});

describe("a migration is atomic", () => {
  test("a file that fails midway leaves user_version and the schema unchanged", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-atomic-"));
    const path = join(directory, "tempad.db");

    // Bring the database fully up to date first.
    const database = openDatabase(path);
    const versionBefore = (database.query("PRAGMA user_version").get() as { user_version: number })
      .user_version;
    const tablesBefore = (
      database.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    database.close();

    // A migration whose first statement succeeds and whose second cannot: the
    // first must not survive. `sqlite_master` is read-only, so the UPDATE
    // fails with a plain error rather than one of the tolerated messages.
    writeFileSync(
      EXTRA,
      [
        "CREATE TABLE atomicity_probe (id TEXT PRIMARY KEY);",
        "UPDATE sqlite_master SET name = name;",
      ].join("\n"),
    );

    expect(() => openDatabase(path)).toThrow();

    const after = new Database(path);
    expect(
      (after.query("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(versionBefore);
    const tablesAfter = (
      after.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(tablesAfter).toEqual(tablesBefore);
    expect(tablesAfter).not.toContain("atomicity_probe");
    after.close();

    rmSync(directory, { recursive: true, force: true });
  });

  test("a migration that succeeds commits its version bump", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-atomic-"));
    const path = join(directory, "tempad.db");

    openDatabase(path).close();
    writeFileSync(EXTRA, "CREATE TABLE atomicity_probe (id TEXT PRIMARY KEY);");

    const database = openDatabase(path);
    expect(
      (database.query("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(9999);
    expect(
      database
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("atomicity_probe"),
    ).toEqual({ name: "atomicity_probe" });
    database.close();

    rmSync(directory, { recursive: true, force: true });
  });
});
