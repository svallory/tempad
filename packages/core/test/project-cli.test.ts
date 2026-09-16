import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProjectCommand } from "../src/cli.ts";
import { openDatabase } from "../src/db/database.ts";

function harness(root: string, home: string) {
  const database = openDatabase(join(root, "tempad.db"));
  const lines: string[] = [];
  const errors: string[] = [];
  const context = {
    database,
    tomlPath: join(root, "tempad.toml"),
    stdout: (line: string) => lines.push(line),
    stderr: (line: string) => errors.push(line),
    homedir: () => home,
  };
  return {
    database,
    lines,
    errors,
    run: (args: string[]) => runProjectCommand(args, context),
  };
}

describe("tempad project (CLI)", () => {
  test("register, list, reresolve wire through to the library functions", async () => {
    const root = mkdtempSync(join(tmpdir(), "tempad-project-cli-"));
    const home = join(root, "home");
    const projectDir = join(root, "work", "mosaic", "coolify");
    mkdirSync(home, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    try {
      const { run, lines, database } = harness(root, home);

      database.exec(
        `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, path_meta, title, title_source, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES ('sess-1', '~/.claude', 'p', '/tmp/sess-1.jsonl', '${projectDir}', 'mosaic', 'coolify-old', NULL, NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1, 0, '[]', 'test-host', '2026-01-01T00:00:00.000Z')`,
      );

      const registerCode = await run([
        "register",
        projectDir,
        "--name",
        "Dev Server",
        "--org",
        "mosaic",
        "--project",
        "coolify",
      ]);
      expect(registerCode).toBe(0);
      expect(lines.at(-1)).toContain("registered");
      expect(lines.at(-1)).toContain("1 session(s) reresolved");

      const row = database
        .query("SELECT org, project, project_name FROM claude_sessions WHERE id = 'sess-1'")
        .get() as { org: string; project: string; project_name: string | null };
      expect(row).toEqual({ org: "mosaic", project: "coolify", project_name: "Dev Server" });

      const listCode = await run(["list"]);
      expect(listCode).toBe(0);
      expect(lines.some((line) => line.startsWith("path\t") && line.includes("Dev Server"))).toBe(
        true,
      );

      database.exec(
        `UPDATE claude_sessions SET org = 'stale', project = 'stale', project_name = NULL WHERE id = 'sess-1'`,
      );
      const reresolveCode = await run(["reresolve", projectDir]);
      expect(reresolveCode).toBe(0);
      expect(lines.at(-1)).toContain("reresolved 1 session(s)");

      const afterReresolve = database
        .query("SELECT org, project, project_name FROM claude_sessions WHERE id = 'sess-1'")
        .get() as { org: string; project: string; project_name: string | null };
      expect(afterReresolve).toEqual({
        org: "mosaic",
        project: "coolify",
        project_name: "Dev Server",
      });

      database.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("register with a trailing slash on the path matches sessions without one", async () => {
    const root = mkdtempSync(join(tmpdir(), "tempad-project-cli-"));
    const home = join(root, "home");
    const projectDir = join(root, "work", "mosaic", "coolify");
    mkdirSync(home, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    try {
      const { run, database } = harness(root, home);
      database.exec(
        `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, path_meta, title, title_source, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES ('sess-1', '~/.claude', 'p', '/tmp/sess-1.jsonl', '${projectDir}', 'x', 'y', NULL, NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1, 0, '[]', 'test-host', '2026-01-01T00:00:00.000Z')`,
      );

      const code = await run([
        "register",
        `${projectDir}/`,
        "--name",
        "Dev Server",
        "--org",
        "mosaic",
        "--project",
        "coolify",
      ]);
      expect(code).toBe(0);

      const row = database
        .query("SELECT project_name FROM claude_sessions WHERE id = 'sess-1'")
        .get() as { project_name: string | null };
      expect(row.project_name).toBe("Dev Server");

      database.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  if (process.platform === "darwin") {
    test("on darwin, a differently-cased registered path still matches the session's cwd", async () => {
      const root = mkdtempSync(join(tmpdir(), "tempad-project-cli-"));
      const home = join(root, "home");
      const projectDir = join(root, "work", "mosaic", "coolify");
      mkdirSync(home, { recursive: true });
      mkdirSync(projectDir, { recursive: true });

      try {
        const { run, database } = harness(root, home);
        database.exec(
          `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, path_meta, title, title_source, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
           VALUES ('sess-1', '~/.claude', 'p', '/tmp/sess-1.jsonl', '${projectDir.toUpperCase()}', 'x', 'y', NULL, NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1, 0, '[]', 'test-host', '2026-01-01T00:00:00.000Z')`,
        );

        const code = await run([
          "register",
          projectDir,
          "--name",
          "Dev Server",
          "--org",
          "mosaic",
          "--project",
          "coolify",
        ]);
        expect(code).toBe(0);

        const row = database
          .query("SELECT project_name FROM claude_sessions WHERE id = 'sess-1'")
          .get() as { project_name: string | null };
        expect(row.project_name).toBe("Dev Server");

        database.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test("registering a symlinked path still matches sessions whose cwd is the resolved real folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "tempad-project-cli-"));
    const home = join(root, "home");
    const realDir = join(root, "real", "coolify");
    const linkDir = join(root, "link");
    mkdirSync(home, { recursive: true });
    mkdirSync(realDir, { recursive: true });
    symlinkSync(realDir, linkDir);

    try {
      const { run, database } = harness(root, home);
      // Stored as the OS-canonical form, matching what a real shell/session
      // would report -- not `realDir`'s literal string, which itself may sit
      // under an ambient symlink (e.g. macOS `/tmp` -> `/private/tmp`) that
      // has nothing to do with the `linkDir` symlink this test exercises.
      const canonicalRealDir = realpathSync(realDir);
      database.exec(
        `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, path_meta, title, title_source, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES ('sess-1', '~/.claude', 'p', '/tmp/sess-1.jsonl', '${canonicalRealDir}', 'x', 'y', NULL, NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1, 0, '[]', 'test-host', '2026-01-01T00:00:00.000Z')`,
      );

      const code = await run([
        "register",
        linkDir,
        "--name",
        "Dev Server",
        "--org",
        "mosaic",
        "--project",
        "coolify",
      ]);
      expect(code).toBe(0);

      const row = database
        .query("SELECT project_name FROM claude_sessions WHERE id = 'sess-1'")
        .get() as { project_name: string | null };
      expect(row.project_name).toBe("Dev Server");

      database.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("register works when HOME-style homedir() cannot resolve a home-relative path (absolute path given)", async () => {
    const root = mkdtempSync(join(tmpdir(), "tempad-project-cli-"));
    const projectDir = join(root, "work", "mosaic", "coolify");
    mkdirSync(projectDir, { recursive: true });

    try {
      const database = openDatabase(join(root, "tempad.db"));
      const lines: string[] = [];
      const context = {
        database,
        tomlPath: join(root, "tempad.toml"),
        stdout: (line: string) => lines.push(line),
        stderr: (line: string) => {
          throw new Error(line);
        },
        homedir: () => "",
      };

      database.exec(
        `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, path_meta, title, title_source, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
         VALUES ('sess-1', '~/.claude', 'p', '/tmp/sess-1.jsonl', '${projectDir}', 'x', 'y', NULL, NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1, 0, '[]', 'test-host', '2026-01-01T00:00:00.000Z')`,
      );

      const code = await runProjectCommand(
        ["register", projectDir, "--name", "Dev Server", "--org", "mosaic", "--project", "coolify"],
        context,
      );
      expect(code).toBe(0);

      const row = database
        .query("SELECT project_name FROM claude_sessions WHERE id = 'sess-1'")
        .get() as { project_name: string | null };
      expect(row.project_name).toBe("Dev Server");

      database.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
