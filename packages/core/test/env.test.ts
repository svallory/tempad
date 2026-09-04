import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/env.ts";

const REQUIRED_ENV_NAMES = [
  "MONDAY_API_TOKEN",
  "MONDAY_USER",
  "GH_USER",
  "GH_ORGS",
  "GH_INCLUDE_PERSONAL",
  "GIT_AUTHOR_EMAILS",
  "CLAUDE_DIRS",
  "HOST_SLUG",
  "TZ",
  "SINCE",
];

let tempHome: string;
let originalEnv: Record<string, string | undefined>;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "tempad-env-test-"));
  originalEnv = {};
  for (const name of [...REQUIRED_ENV_NAMES, "GH_TOKEN", "TEMPAD_HOME"]) {
    originalEnv[name] = process.env[name];
    delete process.env[name];
  }
  process.env.TEMPAD_HOME = tempHome;
});

afterEach(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

function writeEnvFile(content: string): void {
  writeFileSync(join(tempHome, ".env"), content);
}

const VALID_ENV: Record<string, string> = {
  MONDAY_API_TOKEN: "token123",
  MONDAY_USER: "42",
  GH_USER: "svallory",
  GH_ORGS: "mosaicstg",
  GH_INCLUDE_PERSONAL: "true",
  GIT_AUTHOR_EMAILS: "me@example.com",
  CLAUDE_DIRS: "~/.claude",
  HOST_SLUG: "laptop",
  TZ: "America/Sao_Paulo",
  SINCE: "2026-01-01",
};

function writeValidEnvWithOverride(name: string, value: string): void {
  const values = { ...VALID_ENV, [name]: value };
  writeEnvFile(
    Object.entries(values)
      .map(([key, val]) => `${key}=${val}`)
      .join("\n"),
  );
}

describe("loadConfig", () => {
  test("throws one error listing every missing variable", () => {
    writeEnvFile("");
    expect(() => loadConfig()).toThrow();
    try {
      loadConfig();
      throw new Error("expected loadConfig to throw");
    } catch (error) {
      const message = (error as Error).message;
      for (const name of REQUIRED_ENV_NAMES) {
        expect(message).toContain(name);
      }
      expect(message).not.toContain("GH_TOKEN");
    }
  });

  test("happy path parses lists, booleans, and home expansion", () => {
    writeEnvFile(
      [
        "MONDAY_API_TOKEN=token123",
        "MONDAY_USER=42",
        "GH_USER=svallory",
        "GH_ORGS=mosaicstg, other-org",
        "GH_INCLUDE_PERSONAL=true",
        "GIT_AUTHOR_EMAILS=me@example.com, other@example.com",
        "CLAUDE_DIRS=~/.claude,~/.claude-mosaic",
        "HOST_SLUG=laptop",
        "TZ=America/Sao_Paulo",
        "SINCE=2026-01-01",
      ].join("\n"),
    );

    const config = loadConfig();

    expect(config.mondayApiToken).toBe("token123");
    expect(config.ghOrgs).toEqual(["mosaicstg", "other-org"]);
    expect(config.ghIncludePersonal).toBe(true);
    expect(config.gitAuthorEmails).toEqual(["me@example.com", "other@example.com"]);
    expect(config.claudeDirs.every((dir) => !dir.startsWith("~"))).toBe(true);
    expect(config.ghToken).toBeUndefined();
  });

  test("bad boolean throws", () => {
    writeEnvFile(
      [
        "MONDAY_API_TOKEN=token123",
        "MONDAY_USER=42",
        "GH_USER=svallory",
        "GH_ORGS=mosaicstg",
        "GH_INCLUDE_PERSONAL=yes",
        "GIT_AUTHOR_EMAILS=me@example.com",
        "CLAUDE_DIRS=~/.claude",
        "HOST_SLUG=laptop",
        "TZ=America/Sao_Paulo",
        "SINCE=2026-01-01",
      ].join("\n"),
    );

    expect(() => loadConfig()).toThrow(/GH_INCLUDE_PERSONAL/);
  });

  test("empty value on a required var counts as missing", () => {
    writeValidEnvWithOverride("MONDAY_API_TOKEN", "");
    try {
      loadConfig();
      throw new Error("expected loadConfig to throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("MONDAY_API_TOKEN");
      for (const name of REQUIRED_ENV_NAMES) {
        if (name === "MONDAY_API_TOKEN") continue;
        expect(message).not.toContain(name);
      }
    }
  });

  test("whitespace-only value on a required var counts as missing", () => {
    writeValidEnvWithOverride("HOST_SLUG", "   ");
    try {
      loadConfig();
      throw new Error("expected loadConfig to throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("HOST_SLUG");
      for (const name of REQUIRED_ENV_NAMES) {
        if (name === "HOST_SLUG") continue;
        expect(message).not.toContain(name);
      }
    }
  });

  test("empty comma list counts as missing", () => {
    writeValidEnvWithOverride("GH_ORGS", "");
    try {
      loadConfig();
      throw new Error("expected loadConfig to throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("GH_ORGS");
      for (const name of REQUIRED_ENV_NAMES) {
        if (name === "GH_ORGS") continue;
        expect(message).not.toContain(name);
      }
    }
  });

  test("comma list of only commas/whitespace counts as missing", () => {
    writeValidEnvWithOverride("CLAUDE_DIRS", " , ,");
    try {
      loadConfig();
      throw new Error("expected loadConfig to throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("CLAUDE_DIRS");
      for (const name of REQUIRED_ENV_NAMES) {
        if (name === "CLAUDE_DIRS") continue;
        expect(message).not.toContain(name);
      }
    }
  });

  test("empty GH_TOKEN is allowed (optional)", () => {
    writeValidEnvWithOverride("GH_TOKEN", "");
    const config = loadConfig();
    expect(config.ghToken).toBe("");
  });
});
