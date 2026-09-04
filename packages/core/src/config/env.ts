import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  mondayApiToken: string;
  mondayUser: string;
  ghUser: string;
  ghOrgs: string[];
  ghIncludePersonal: boolean;
  ghToken: string | undefined;
  gitAuthorEmails: string[];
  claudeDirs: string[];
  hostSlug: string;
  tz: string;
  since: string;
  home: string;
}

interface RequiredVar {
  key: string;
  envName: string;
}

const COMMA_LIST_NAMES = new Set(["GH_ORGS", "GIT_AUTHOR_EMAILS", "CLAUDE_DIRS"]);

const REQUIRED_VARS: RequiredVar[] = [
  { key: "mondayApiToken", envName: "MONDAY_API_TOKEN" },
  { key: "mondayUser", envName: "MONDAY_USER" },
  { key: "ghUser", envName: "GH_USER" },
  { key: "ghOrgs", envName: "GH_ORGS" },
  { key: "ghIncludePersonal", envName: "GH_INCLUDE_PERSONAL" },
  { key: "gitAuthorEmails", envName: "GIT_AUTHOR_EMAILS" },
  { key: "claudeDirs", envName: "CLAUDE_DIRS" },
  { key: "hostSlug", envName: "HOST_SLUG" },
  { key: "tz", envName: "TZ" },
  { key: "since", envName: "SINCE" },
];

function expandHome(value: string, home: string): string {
  return value.startsWith("~") ? join(home, value.slice(1)) : value;
}

function parseCommaList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseBoolean(value: string, envName: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Invalid boolean for ${envName}: expected "true" or "false", got "${value}"`);
}

function parseDotEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;

    const name = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[name] = value;
  }
  return values;
}

export function loadConfig(): Config {
  const home = homedir();
  const tempadHome = process.env.TEMPAD_HOME
    ? expandHome(process.env.TEMPAD_HOME, home)
    : join(home, ".tempad");

  const envPath = join(tempadHome, ".env");
  const fileValues = parseDotEnv(existsSync(envPath) ? readFileSync(envPath, "utf8") : "");

  const read = (name: string): string | undefined => process.env[name] ?? fileValues[name];

  const isMissing = (name: string): boolean => {
    const raw = read(name);
    if (raw === undefined || raw.trim().length === 0) return true;
    if (COMMA_LIST_NAMES.has(name)) return parseCommaList(raw).length === 0;
    return false;
  };

  const missing: string[] = [];
  for (const { envName } of REQUIRED_VARS) {
    if (isMissing(envName)) missing.push(envName);
  }
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  return {
    mondayApiToken: read("MONDAY_API_TOKEN") as string,
    mondayUser: read("MONDAY_USER") as string,
    ghUser: read("GH_USER") as string,
    ghOrgs: parseCommaList(read("GH_ORGS") as string),
    ghIncludePersonal: parseBoolean(read("GH_INCLUDE_PERSONAL") as string, "GH_INCLUDE_PERSONAL"),
    ghToken: read("GH_TOKEN"),
    gitAuthorEmails: parseCommaList(read("GIT_AUTHOR_EMAILS") as string),
    claudeDirs: parseCommaList(read("CLAUDE_DIRS") as string).map((dir) => expandHome(dir, home)),
    hostSlug: read("HOST_SLUG") as string,
    tz: read("TZ") as string,
    since: read("SINCE") as string,
    home: tempadHome,
  };
}
