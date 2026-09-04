import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

export interface PathRule {
  pattern: string;
  org?: string;
  project?: string;
}

export interface RepositoryRule {
  full_name: string;
  org: string;
  project: string;
  [key: string]: string;
}

export interface BoardRule {
  name: string;
  org: string;
  project: string;
  [key: string]: string;
}

interface CompiledRule {
  urlPattern: URLPattern;
  org: string | undefined;
  project: string | undefined;
}

export interface ResolvedPath {
  org: string;
  project: string;
  meta: Record<string, string>;
}

export interface ResolvedEntity {
  org: string;
  project: string;
  meta: Record<string, string>;
}

export interface Rules {
  projects: CompiledRule[];
  repositories: RepositoryRule[];
  boards: BoardRule[];
}

function expandHome(pattern: string, home: string): string {
  return pattern.startsWith("~") ? home + pattern.slice(1) : pattern;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function validateEntityRules<T extends Record<string, unknown>>(
  rawRules: T[],
  kind: "repositories" | "boards",
  keyField: string,
): void {
  rawRules.forEach((rule, index) => {
    if (typeof rule[keyField] !== "string" || (rule[keyField] as string).length === 0) {
      throw new Error(`${kind} entry at index ${index} is missing "${keyField}"`);
    }
    if (typeof rule.org !== "string" || rule.org.length === 0) {
      throw new Error(
        `${kind} entry at index ${index} (${keyField} "${rule[keyField]}") is missing "org"`,
      );
    }
    if (typeof rule.project !== "string" || rule.project.length === 0) {
      throw new Error(
        `${kind} entry at index ${index} (${keyField} "${rule[keyField]}") is missing "project"`,
      );
    }
  });
}

export function loadRules(tomlPath: string): Rules {
  if (!existsSync(tomlPath)) {
    return { projects: [], repositories: [], boards: [] };
  }

  const text = readFileSync(tomlPath, "utf8");
  const parsed = Bun.TOML.parse(text) as {
    projects?: PathRule[];
    repositories?: RepositoryRule[];
    boards?: BoardRule[];
  };
  const rawRules = parsed.projects ?? [];
  const home = homedir();

  const projects = rawRules.map((rule, index) => {
    const pathname = expandHome(rule.pattern, home);
    const urlPattern = new URLPattern({ pathname });

    const groupNames = extractGroupNames(pathname);
    const hasOrgGroup = groupNames.has("org");
    const hasProjectGroup = groupNames.has("project");

    if (!rule.org && !hasOrgGroup) {
      throw new Error(`Rule at index ${index} (pattern "${rule.pattern}") cannot supply "org"`);
    }
    if (!rule.project && !hasProjectGroup) {
      throw new Error(`Rule at index ${index} (pattern "${rule.pattern}") cannot supply "project"`);
    }

    return { urlPattern, org: rule.org, project: rule.project };
  });

  const repositories = parsed.repositories ?? [];
  validateEntityRules(repositories, "repositories", "full_name");

  const boards = parsed.boards ?? [];
  validateEntityRules(boards, "boards", "name");

  return { projects, repositories, boards };
}

function extractGroupNames(pathname: string): Set<string> {
  const names = new Set<string>();
  const regex = /:([A-Za-z_$][A-Za-z0-9_$]*)/g;
  for (const match of pathname.matchAll(regex)) {
    const name = match[1];
    if (name) names.add(name);
  }
  return names;
}

export function resolvePath(rules: Rules, absolutePath: string): ResolvedPath {
  for (const rule of rules.projects) {
    const match = rule.urlPattern.exec({ pathname: absolutePath });
    if (!match) continue;

    const groups = match.pathname.groups as Record<string, string | undefined>;
    const org = rule.org ?? groups.org;
    const project = rule.project ?? groups.project;

    if (org === undefined || project === undefined) continue;

    const meta: Record<string, string> = {};
    for (const [name, value] of Object.entries(groups)) {
      if (name === "org" || name === "project" || value === undefined) continue;
      meta[name] = value;
    }

    return { org, project, meta };
  }

  return { org: "unassigned", project: "unassigned", meta: {} };
}

function metaFromEntity<T extends Record<string, unknown>>(
  rule: T,
  excludeKeys: string[],
): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const [key, value] of Object.entries(rule)) {
    if (excludeKeys.includes(key)) continue;
    if (typeof value === "string") meta[key] = value;
  }
  return meta;
}

export function resolveRepository(rules: Rules, fullName: string): ResolvedEntity {
  const lowerFullName = fullName.toLowerCase();
  const match = rules.repositories.find((rule) => rule.full_name.toLowerCase() === lowerFullName);
  if (match) {
    return {
      org: match.org,
      project: match.project,
      meta: metaFromEntity(match, ["full_name", "org", "project"]),
    };
  }

  const [owner, repo] = fullName.split("/");
  return {
    org: (owner ?? fullName).toLowerCase(),
    project: (repo ?? fullName).toLowerCase(),
    meta: {},
  };
}

export function resolveBoard(rules: Rules, boardName: string): ResolvedEntity {
  const lowerName = boardName.toLowerCase();
  const match = rules.boards.find((rule) => rule.name.toLowerCase() === lowerName);
  if (match) {
    return {
      org: match.org,
      project: match.project,
      meta: metaFromEntity(match, ["name", "org", "project"]),
    };
  }

  return { org: "monday", project: slugify(boardName), meta: {} };
}
