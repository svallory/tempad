import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadRules, resolvePath } from "../src/config/rules.ts";

function writeToml(content: string): string {
  const path = join(tmpdir(), `tempad-rules-${Math.random().toString(36).slice(2)}.toml`);
  writeFileSync(path, content);
  return path;
}

describe("loadRules / resolvePath", () => {
  test("expands ~ and matches org/project from named groups", () => {
    const path = writeToml(`
[[projects]]
pattern = "~/work/:org/:project/:rest*"
`);
    const rules = loadRules(path);
    const home = homedir();
    const result = resolvePath(rules, `${home}/work/mosaic/campaigns/apps/web`);
    expect(result).toEqual({
      org: "mosaic",
      project: "campaigns",
      meta: { rest: "apps/web" },
    });
  });

  test("static org field with named project group", () => {
    const path = writeToml(`
[[projects]]
pattern = "~/projects/:project/:rest*"
org = "personal"
`);
    const rules = loadRules(path);
    const home = homedir();
    const result = resolvePath(rules, `${home}/projects/tempad/src`);
    expect(result).toEqual({
      org: "personal",
      project: "tempad",
      meta: { rest: "src" },
    });
  });

  test("scratchpad pattern from spec", () => {
    const path = writeToml(`
[[projects]]
pattern = "/private/tmp/claude-501/-Users-svallory-work-:org-:project-:rest*"
`);
    const rules = loadRules(path);
    const result = resolvePath(
      rules,
      "/private/tmp/claude-501/-Users-svallory-work-tempad-core-foundation-scratchpad",
    );
    expect(result.org).toBe("tempad");
    expect(result.project).toBe("core");
  });

  test("no match returns unassigned", () => {
    const path = writeToml(`
[[projects]]
pattern = "~/work/:org/:project/:rest*"
`);
    const rules = loadRules(path);
    const result = resolvePath(rules, "/some/other/path");
    expect(result).toEqual({ org: "unassigned", project: "unassigned", meta: {} });
  });

  test("first match wins", () => {
    const path = writeToml(`
[[projects]]
pattern = "~/work/:org/:project/:rest*"
org = "first"

[[projects]]
pattern = "~/work/:org2/:project2/:rest2*"
org = "second"
project = "second-project"
`);
    const rules = loadRules(path);
    const home = homedir();
    const result = resolvePath(rules, `${home}/work/anything/proj`);
    expect(result.org).toBe("first");
  });

  test("rule missing both org and project fails at load time", () => {
    const path = writeToml(`
[[projects]]
pattern = "~/work/:rest*"
`);
    expect(() => loadRules(path)).toThrow();
  });
});
