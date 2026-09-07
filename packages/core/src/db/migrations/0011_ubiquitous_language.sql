-- Ubiquitous language rename (2026-09-07): Goal -> Saga, Activity -> Stint.
-- See docs/specs/2026-09-07-ubiquitous-language.md.
--
-- `goals`, `activities` and `quests` are projection tables, created lazily by
-- ensureTables (src/intent/projections/index.ts) rather than by a migration,
-- so on a database where the intent layer was never used they do not exist
-- yet. runMigration tolerates "no such table"/"no such column" for a file of
-- ALTERs only (see src/db/database.ts), so a database that never created these
-- tables just skips these statements and gets the new names from the
-- projection's own createSql instead.
ALTER TABLE goals RENAME TO sagas;
ALTER TABLE activities RENAME TO stints;
ALTER TABLE stints DROP COLUMN outcome;
ALTER TABLE stints RENAME COLUMN objective TO outcome;
ALTER TABLE traces RENAME COLUMN activity_id TO stint_id;
ALTER TABLE trace_links RENAME COLUMN activity_id TO stint_id;
ALTER TABLE quests RENAME COLUMN goal_id TO serves;
ALTER TABLE quests RENAME COLUMN objective TO outcome;
ALTER TABLE quests RENAME COLUMN origin_activity_id TO deviates_from_stint_id;
