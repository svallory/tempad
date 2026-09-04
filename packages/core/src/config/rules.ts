import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

export interface PathRule {
  pattern: string;
  org?: string;
  project?: string;
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

function expandHome(pattern: string, home: string): string {
  return pattern.startsWith("~") ? home + pattern.slice(1) : pattern;
}

export function loadRules(tomlPath: string): CompiledRule[] {
  if (!existsSync(tomlPath)) {
    throw new Error(`Rules file not found: ${tomlPath}`);
  }

  const text = readFileSync(tomlPath, "utf8");
  const parsed = Bun.TOML.parse(text) as { projects?: PathRule[] };
  const rawRules = parsed.projects ?? [];
  const home = homedir();

  return rawRules.map((rule, index) => {
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

export function resolvePath(rules: CompiledRule[], absolutePath: string): ResolvedPath {
  for (const rule of rules) {
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
