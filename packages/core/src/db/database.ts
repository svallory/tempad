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
    database.exec(migration.sql);
    database.exec(`PRAGMA user_version = ${migration.version};`);
  }

  return database;
}
