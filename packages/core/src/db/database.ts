import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

function loadMigrations(): { version: number; sql: string }[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  return files.map((file) => {
    const match = file.match(/^(\d+)_/);
    if (!match?.[1]) {
      throw new Error(`Migration file name must start with a number: ${file}`);
    }
    return {
      version: Number.parseInt(match[1], 10),
      sql: readFileSync(join(MIGRATIONS_DIR, file), "utf8"),
    };
  });
}

export function openDatabase(path: string): Database {
  const database = new Database(path);
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA foreign_keys = ON;");

  const currentVersion = (database.query("PRAGMA user_version;").get() as { user_version: number })
    .user_version;

  const migrations = loadMigrations();
  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;
    runMigration(database, migration.sql);
    database.exec(`PRAGMA user_version = ${migration.version};`);
  }

  return database;
}

/**
 * Some tables (`traces`, `activities`, `quests`) are projection tables
 * created lazily by `ensureTables` (`src/intent/projections/index.ts`), not
 * by a migration -- so an `ALTER TABLE ... ADD COLUMN` targeting one of them
 * fails with "no such table" on a database where the intent layer was never
 * used. That's fine: the projection's own `createSql` already includes the
 * column for any table it creates from scratch, so skipping the ALTER here
 * is a no-op, not data loss.
 *
 * Only migration files that consist solely of such statements go through
 * this per-statement, tolerant path; every other migration (some of which
 * define triggers whose bodies contain their own semicolons, e.g.
 * 0003_events.sql) still runs as one plain `exec` so its statements are
 * never split apart.
 */
function runMigration(database: Database, sql: string): void {
  const statements = sql
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  const allAlterAddColumn = statements.every((statement) =>
    /^ALTER TABLE \S+ ADD COLUMN/i.test(statement),
  );

  if (!allAlterAddColumn) {
    database.exec(sql);
    return;
  }

  for (const statement of statements) {
    try {
      database.exec(statement);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("no such table")) continue;
      throw error;
    }
  }
}
