import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { deriveOrgProject, registerProject } from "../src/config/project-register.ts";
import { loadRules, resolvePath } from "../src/config/rules.ts";

describe("deriveOrgProject", () => {
  test("derives org/project from a matching pattern rule", () => {
    const rules = loadRules(
      writeTomlFor(`[[projects]]\npattern = "~/work/:org/:project/:rest*"\n`),
    );
    const home = homedir();
    const result = deriveOrgProject(rules, `${home}/work/mosaic/coolify`);
    expect(result).toEqual({ org: "mosaic", project: "coolify" });
  });
});

function writeTomlFor(content: string): string {
  const path = join(tmpdir(), `tempad-register-${Math.random().toString(36).slice(2)}.toml`);
  writeFileSync(path, content);
  return path;
}

describe("registerProject", () => {
  test("prepends a path rule, preserving the rest of the file byte-for-byte", () => {
    const root = mkdtempSync(join(tmpdir(), "tempad-register-"));
    const tomlPath = join(root, "tempad.toml");
    const original = `[hero]
name = "Saulo Vallory"

# a comment that must survive
[[projects]]
pattern = "~/work/:org/:project/:rest*"
`;
    writeFileSync(tomlPath, original);

    try {
      registerProject(tomlPath, {
        path: "~/work/mosaic/coolify",
        name: "Dev Server",
        org: "mosaic",
        project: "coolify",
      });

      const updated = readFileSync(tomlPath, "utf8");
      expect(updated).toContain(original.trimEnd());
      expect(updated.indexOf('path = "~/work/mosaic/coolify"')).toBeLessThan(
        updated.indexOf("[hero]"),
      );

      const rules = loadRules(tomlPath);
      const home = homedir();
      const result = resolvePath(rules, `${home}/work/mosaic/coolify`);
      expect(result).toEqual({ org: "mosaic", project: "coolify", meta: {}, name: "Dev Server" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writes the new entry with CRLF line endings when the existing file uses CRLF", () => {
    const root = mkdtempSync(join(tmpdir(), "tempad-register-"));
    const tomlPath = join(root, "tempad.toml");
    const original = '[hero]\r\nname = "Saulo Vallory"\r\n';
    writeFileSync(tomlPath, original);

    try {
      registerProject(tomlPath, {
        path: "~/work/mosaic/coolify",
        name: "Dev Server",
        org: "mosaic",
        project: "coolify",
      });

      const updated = readFileSync(tomlPath, "utf8");
      expect(updated).toContain(original);
      const newEntry = updated.slice(0, updated.indexOf(original));
      expect(newEntry).toContain("\r\n");
      expect(newEntry.replace(/\r\n/g, "")).not.toContain("\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a duplicate path", () => {
    const root = mkdtempSync(join(tmpdir(), "tempad-register-"));
    const tomlPath = join(root, "tempad.toml");
    writeFileSync(
      tomlPath,
      `[[projects]]\npath = "~/work/mosaic/coolify"\nname = "Dev Server"\norg = "mosaic"\nproject = "coolify"\n`,
    );

    try {
      expect(() =>
        registerProject(tomlPath, {
          path: "~/work/mosaic/coolify",
          name: "Dev Server 2",
          org: "mosaic",
          project: "coolify",
        }),
      ).toThrow(/already registered/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
