import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db/database";
import { runIntentCommand } from "../../src/intent/cli";
import { defaultIntentConfig } from "../../src/intent/config";

function harness() {
  const database = openDatabase(":memory:");
  const lines: string[] = [];
  const context = {
    database,
    config: {} as never,
    intentConfig: defaultIntentConfig(),
    stdout: (line: string) => lines.push(line),
  };
  return { database, lines, run: (args: string[]) => runIntentCommand(args, context) };
}

describe("tempad impact", () => {
  test("set stores an impact", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    expect(
      await run(["impact", "set", "commit:abc1234", "Fixed the crash", "--theme", "fix"]),
    ).toBe(0);
    const row = database
      .query("SELECT text, theme FROM impacts WHERE subject = ?")
      .get("commit:abc1234") as { text: string; theme: string | null };
    expect(row.text).toBe("Fixed the crash");
    expect(row.theme).toBe("fix");
  });

  test("set stores a session impact", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    expect(
      await run([
        "impact",
        "set",
        "session:3d4f5a96-77fa-478a-accc-d804f2fad104",
        "Restored production access",
        "--theme",
        "fix",
      ]),
    ).toBe(0);
    const row = database
      .query("SELECT text, theme FROM impacts WHERE subject = ?")
      .get("session:3d4f5a96-77fa-478a-accc-d804f2fad104") as {
      text: string;
      theme: string | null;
    };
    expect(row.text).toBe("Restored production access");
    expect(row.theme).toBe("fix");
  });

  test("set rejects an unknown ref shape and names the accepted shapes", async () => {
    const { run } = harness();
    await run(["hero", "init", "S"]);
    const originalError = console.error;
    let message = "";
    console.error = (line: string) => {
      message = line;
    };
    expect(await run(["impact", "set", "issue:42", "Text"])).toBe(1);
    console.error = originalError;
    expect(message).toContain("pr:<repo>#<number>");
    expect(message).toContain("commit:<sha>");
    expect(message).toContain("monday:<item id>");
    expect(message).toContain("session:<claude session id>");
  });

  test("set rejects blank text with the same message as import, exit 1", async () => {
    const { run } = harness();
    await run(["hero", "init", "S"]);
    const originalError = console.error;
    let message = "";
    console.error = (line: string) => {
      message = line;
    };
    expect(await run(["impact", "set", "commit:abc1234", "   "])).toBe(1);
    console.error = originalError;
    expect(message).toBe("text must not be empty");
  });

  test("set rejects an invalid theme with a clean message naming the regex, exit 1", async () => {
    const { run } = harness();
    await run(["hero", "init", "S"]);
    const originalError = console.error;
    let message = "";
    console.error = (line: string) => {
      message = line;
    };
    expect(await run(["impact", "set", "commit:abc1234", "Text", "--theme", "Not_Valid"])).toBe(1);
    console.error = originalError;
    expect(message).toContain("^[a-z][a-z-]*$");
  });

  test("list shows (not mirrored) for a ref absent from the mirrors", async () => {
    const { run, lines } = harness();
    await run(["hero", "init", "S"]);
    await run(["impact", "set", "commit:deadbeef", "Some fix"]);
    expect(await run(["impact", "list"])).toBe(0);
    expect(lines.some((line) => line.includes("(not mirrored)"))).toBe(true);
  });

  test("list joins the mirror row when it exists", async () => {
    const { run, lines, database } = harness();
    await run(["hero", "init", "S"]);
    database.exec(
      "INSERT INTO gh_repos (full_name, org, is_personal, project) VALUES ('org/repo', 'org', 0, 'proj')",
    );
    database.exec(
      `INSERT INTO gh_commits (sha, repo, branches, author_name, author_email, authored_at, committed_at, subject)
       VALUES ('deadbeef', 'org/repo', '[]', 'A', 'a@example.com', '2026-09-10T00:00:00.000Z', '2026-09-10T00:00:00.000Z', 'Fix bug')`,
    );
    await run(["impact", "set", "commit:deadbeef", "Fixed a client-visible crash"]);
    expect(await run(["impact", "list"])).toBe(0);
    const line = lines.find((entry) => entry.startsWith("commit:deadbeef"));
    expect(line).toContain("proj");
    expect(line).toContain("Fix bug");
  });

  test("list shows (not mirrored) for a session ref absent from claude_sessions", async () => {
    const { run, lines } = harness();
    await run(["hero", "init", "S"]);
    await run([
      "impact",
      "set",
      "session:3d4f5a96-77fa-478a-accc-d804f2fad104",
      "Restored production access",
    ]);
    expect(await run(["impact", "list"])).toBe(0);
    const line = lines.find((entry) =>
      entry.startsWith("session:3d4f5a96-77fa-478a-accc-d804f2fad104"),
    );
    expect(line).toContain("(not mirrored)");
  });

  test("list joins the mirror row when the session exists in claude_sessions", async () => {
    const { run, lines, database } = harness();
    await run(["hero", "init", "S"]);
    database.exec(
      `INSERT INTO claude_sessions (id, claude_dir, project_dir, file_path, cwd, org, project, path_meta, title, title_source, git_branch, started_at, ended_at, message_count, tool_call_count, models, host_slug, file_mtime)
       VALUES ('3d4f5a96-77fa-478a-accc-d804f2fad104', '~/.claude', 'dir', '/tmp/s.jsonl', NULL, 'org', 'proj', NULL, 'Ops session on Coolify', 'custom-title', NULL, '2026-09-10T00:00:00.000Z', '2026-09-10T01:00:00.000Z', 2, 0, '[]', 'host', '2026-09-10T01:00:00.000Z')`,
    );
    await run([
      "impact",
      "set",
      "session:3d4f5a96-77fa-478a-accc-d804f2fad104",
      "Restored production access",
    ]);
    expect(await run(["impact", "list"])).toBe(0);
    const line = lines.find((entry) =>
      entry.startsWith("session:3d4f5a96-77fa-478a-accc-d804f2fad104"),
    );
    expect(line).toContain("proj");
    expect(line).toContain("Ops session on Coolify");
  });

  test("import applies each entry as one event and prints imported=<n>", async () => {
    const { run, database, lines } = harness();
    await run(["hero", "init", "S"]);
    const dir = mkdtempSync(join(tmpdir(), "tempad-impact-import-"));
    const file = join(dir, "impacts.json");
    writeFileSync(
      file,
      JSON.stringify([
        { ref: "commit:aaa1111", text: "A" },
        { ref: "monday:42", text: "B", theme: "feature" },
        { ref: "session:3d4f5a96-77fa-478a-accc-d804f2fad104", text: "C", theme: "process" },
      ]),
    );
    expect(await run(["impact", "import", file])).toBe(0);
    const rows = database
      .query("SELECT subject, text, theme FROM impacts ORDER BY subject")
      .all() as {
      subject: string;
      text: string;
      theme: string | null;
    }[];
    expect(rows).toEqual([
      { subject: "commit:aaa1111", text: "A", theme: null },
      { subject: "monday:42", text: "B", theme: "feature" },
      {
        subject: "session:3d4f5a96-77fa-478a-accc-d804f2fad104",
        text: "C",
        theme: "process",
      },
    ]);
    expect(lines).toContain("imported=3");
  });

  test("import validates every entry before applying any, on a bad entry nothing is applied", async () => {
    const { run, database } = harness();
    await run(["hero", "init", "S"]);
    const dir = mkdtempSync(join(tmpdir(), "tempad-impact-import-"));
    const file = join(dir, "impacts.json");
    writeFileSync(
      file,
      JSON.stringify([
        { ref: "commit:aaa1111", text: "A" },
        { ref: "issue:42", text: "bad ref shape" },
        { ref: "commit:bbb2222", text: "C", theme: "Not_Valid" },
        { ref: "commit:ccc3333", text: "" },
      ]),
    );
    const originalError = console.error;
    let message = "";
    console.error = (line: string) => {
      message += `${line}\n`;
    };
    expect(await run(["impact", "import", file])).toBe(1);
    console.error = originalError;
    expect(message).toContain("entry 2");
    expect(message).toContain("entry 3");
    expect(message).toContain("entry 4");
    const count = database.query("SELECT count(*) as n FROM impacts").get() as { n: number };
    expect(count.n).toBe(0);
  });

  test("import with a missing file exits 1 with a clean message", async () => {
    const { run } = harness();
    await run(["hero", "init", "S"]);
    const originalError = console.error;
    let message = "";
    console.error = (line: string) => {
      message = line;
    };
    expect(await run(["impact", "import", "/nonexistent/impacts.json"])).toBe(1);
    console.error = originalError;
    expect(message).toContain("import file could not be read");
  });

  test("import with malformed JSON exits 1 with a clean message", async () => {
    const { run } = harness();
    await run(["hero", "init", "S"]);
    const dir = mkdtempSync(join(tmpdir(), "tempad-impact-import-"));
    const file = join(dir, "bad.json");
    writeFileSync(file, "{not json");
    const originalError = console.error;
    let message = "";
    console.error = (line: string) => {
      message = line;
    };
    expect(await run(["impact", "import", file])).toBe(1);
    console.error = originalError;
    expect(message.length).toBeGreaterThan(0);
  });

  test("import with a non-array top level exits 1 with a clean message", async () => {
    const { run } = harness();
    await run(["hero", "init", "S"]);
    const dir = mkdtempSync(join(tmpdir(), "tempad-impact-import-"));
    const file = join(dir, "notarray.json");
    writeFileSync(file, JSON.stringify({ ref: "commit:abc1234", text: "A" }));
    const originalError = console.error;
    let message = "";
    console.error = (line: string) => {
      message = line;
    };
    expect(await run(["impact", "import", file])).toBe(1);
    console.error = originalError;
    expect(message).toContain("array");
  });
});
