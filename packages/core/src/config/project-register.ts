import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { loadRules, normalizePathForMatch, type Rules, resolvePath } from "./rules.ts";

export interface RegisterProjectOptions {
  path: string;
  name: string;
  org?: string;
  project?: string;
}

/**
 * `org`/`project` for a folder, derived from the rules already in effect --
 * used by `tempad project register` when the operator omits `--org`/`--project`.
 */
export function deriveOrgProject(
  rules: Rules,
  absolutePath: string,
): { org: string; project: string } {
  const resolved = resolvePath(rules, absolutePath);
  return { org: resolved.org, project: resolved.project };
}

// TOML basic strings escape the same way JSON strings do, so JSON.stringify
// is used here by design as the basic-string escaper -- not a JSON/TOML mixup.
function toml(value: string): string {
  return JSON.stringify(value);
}

/** True for a CRLF-encoded file, so the new entry can match its line ending. */
function usesCrlf(text: string): boolean {
  return text.includes("\r\n");
}

/**
 * Inserts a `[[projects]] path = ... name = ... org = ... project = ...`
 * entry at the very top of `tomlPath`, ahead of every existing table, since
 * path rules must be checked before pattern rules for "first match wins".
 * The rest of the file is preserved exactly -- no TOML round-trip that would
 * reformat comments or spacing.
 */
export function registerProject(tomlPath: string, options: RegisterProjectOptions): void {
  const home = homedir();
  const absolutePath = normalizePathForMatch(options.path, home);

  const existingText = existsSync(tomlPath) ? readFileSync(tomlPath, "utf8") : "";
  const rules = loadRules(tomlPath);

  const duplicate = rules.projects.some(
    (rule) => rule.kind === "path" && rule.absolutePath === absolutePath,
  );
  if (duplicate) {
    throw new Error(`path "${options.path}" is already registered in ${tomlPath}`);
  }

  const derived = deriveOrgProject(rules, absolutePath);
  const org = options.org ?? derived.org;
  const project = options.project ?? derived.project;

  if (org === "unassigned" || project === "unassigned") {
    throw new Error(
      `could not derive org/project for "${options.path}" from existing rules; pass --org and --project`,
    );
  }

  const lineEnding = usesCrlf(existingText) ? "\r\n" : "\n";
  const entry = [
    "[[projects]]",
    `path = ${toml(options.path)}`,
    `name = ${toml(options.name)}`,
    `org = ${toml(org)}`,
    `project = ${toml(project)}`,
    "",
    "",
  ].join(lineEnding);

  writeFileSync(tomlPath, entry + existingText);
}
