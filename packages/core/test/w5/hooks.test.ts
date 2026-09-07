import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAdditionalContext,
  buildBelongsHandback,
  buildDeclarationLine,
  buildDeclareHandback,
  installHooks,
  promptHookScriptPath,
  renderHookSettings,
  stopHookScriptPath,
  uninstallHooks,
} from "../../src/w5/hooks";
import type { QuestionRow } from "../../src/w5/questions";

describe("renderHookSettings", () => {
  test("computes hook paths from the package location, not the bun binary, and writes absolute paths that exist on disk", () => {
    const fragment = renderHookSettings();
    const stopCommand = fragment.Stop[0]?.hooks[0]?.command ?? "";
    const promptCommand = fragment.UserPromptSubmit[0]?.hooks[0]?.command ?? "";

    const stopScript = stopHookScriptPath();
    const promptScript = promptHookScriptPath();

    expect(existsSync(stopScript)).toBe(true);
    expect(existsSync(promptScript)).toBe(true);
    expect(stopScript.startsWith("/")).toBe(true);
    expect(promptScript.startsWith("/")).toBe(true);

    expect(stopCommand).toContain(stopScript);
    expect(promptCommand).toContain(promptScript);
    expect(stopCommand).toMatch(/^TEMPAD_BIN="bun \/.*\/src\/cli\.ts" bash \/.*w5-stop\.sh$/);
  });

  test("marks every entry with tempad: true", () => {
    const fragment = renderHookSettings();
    expect(fragment.Stop[0]?.hooks[0]?.tempad).toBe(true);
    expect(fragment.PreCompact[0]?.hooks[0]?.tempad).toBe(true);
    expect(fragment.SessionEnd[0]?.hooks[0]?.tempad).toBe(true);
    expect(fragment.UserPromptSubmit[0]?.hooks[0]?.tempad).toBe(true);
  });
});

describe("installHooks / uninstallHooks", () => {
  test("creates the settings directory if it doesn't exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-hooks-test-"));
    const nestedSettingsPath = join(dir, "nested", "does", "not", "exist", "settings.json");
    try {
      expect(existsSync(join(dir, "nested"))).toBe(false);
      installHooks(nestedSettingsPath);
      expect(existsSync(nestedSettingsPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("installs alongside an unrelated existing Stop hook, is idempotent, uninstall removes only tempad entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-hooks-test-"));
    const settingsPath = join(dir, "settings.json");
    try {
      writeFileSync(
        settingsPath,
        JSON.stringify({
          hooks: {
            Stop: [{ hooks: [{ type: "command", command: "other-tool" }] }],
          },
        }),
      );

      installHooks(settingsPath);
      const afterFirst = JSON.parse(readFileSync(settingsPath, "utf8"));
      const stopCommands = afterFirst.hooks.Stop.flatMap(
        (entry: { hooks: { command: string }[] }) => entry.hooks.map((hook) => hook.command),
      );
      expect(stopCommands).toContain("other-tool");
      expect(stopCommands.some((command: string) => command.includes("w5-stop.sh"))).toBe(true);

      installHooks(settingsPath);
      const afterSecond = JSON.parse(readFileSync(settingsPath, "utf8"));
      const stopCommandsSecond = afterSecond.hooks.Stop.flatMap(
        (entry: { hooks: { command: string }[] }) => entry.hooks.map((hook) => hook.command),
      );
      const tempadCount = stopCommandsSecond.filter((command: string) =>
        command.includes("w5-stop.sh"),
      ).length;
      expect(tempadCount).toBe(1);

      uninstallHooks(settingsPath);
      const afterUninstall = JSON.parse(readFileSync(settingsPath, "utf8"));
      const stopCommandsThird = afterUninstall.hooks.Stop.flatMap(
        (entry: { hooks: { command: string }[] }) => entry.hooks.map((hook) => hook.command),
      );
      expect(stopCommandsThird).toEqual(["other-tool"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--bin override is reflected in the written command", () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-hooks-test-"));
    const settingsPath = join(dir, "settings.json");
    try {
      installHooks(settingsPath, "/custom/path/cli.ts");
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      const stopCommand = settings.hooks.Stop[0].hooks[0].command as string;
      expect(stopCommand).toContain("bun /custom/path/cli.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildAdditionalContext", () => {
  test("renders the question id and the answer command", () => {
    const questions: QuestionRow[] = [
      {
        id: "Q1",
        traceId: "T1",
        sessionId: "s1",
        kind: "which_quest",
        state: "asked",
        turnsWatched: 3,
        turnsAtAsk: 3,
        isSwitch: true,
      },
    ];
    const text = buildAdditionalContext(questions);
    expect(text).toContain("Q1");
    expect(text).toContain("tempad answer Q1");
  });

  test("returns empty string for no questions", () => {
    expect(buildAdditionalContext([])).toBe("");
  });
});

describe("buildDeclarationLine", () => {
  test("renders 'none' when the session has declared nothing", () => {
    expect(buildDeclarationLine([], "s1")).toBe(
      "tempad: session s1, active quests: none. Declare with the tempad-quest skill if this prompt starts a different outcome.",
    );
  });

  test("renders every active quest bracket-tagged with its alias", () => {
    expect(
      buildDeclarationLine(
        [
          { title: "Ship X", alias: "Q1" },
          { title: "Fix Y", alias: "Q2" },
        ],
        "s1",
      ),
    ).toBe(
      "tempad: session s1, active quests: Ship X [Q1], Fix Y [Q2]. Declare with the tempad-quest skill if this prompt starts a different outcome.",
    );
  });
});

describe("w5-stop.sh", () => {
  test("forwards session id and forces on non-Stop events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-hookscript-test-"));
    try {
      const fakeTempad = join(dir, "tempad");
      const argvLog = join(dir, "argv.log");
      writeFileSync(fakeTempad, `#!/bin/sh\necho "$@" >> "${argvLog}"\n`);
      chmodSync(fakeTempad, 0o755);

      const scriptPath = join(import.meta.dir, "../../hooks/w5-stop.sh");

      const runHook = async (hookEventName: string) => {
        const proc = Bun.spawn({
          cmd: ["bash", scriptPath],
          env: { ...process.env, TEMPAD_BIN: fakeTempad, TEMPAD_HOME: dir },
          stdin: new Response(JSON.stringify({ session_id: "s1", hook_event_name: hookEventName })),
          stdout: "ignore",
          stderr: "ignore",
        });
        await proc.exited;
      };

      await runHook("Stop");
      await runHook("PreCompact");

      const argv = readFileSync(argvLog, "utf8").trim().split("\n");
      expect(argv[0]).toBe("w5 enqueue --session s1 --kind classify");
      expect(argv[1]).toBe("w5 enqueue --session s1 --forced --kind classify");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("forwards SessionEnd as --kind session_end and Stop as --kind classify", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-hookscript-test-"));
    try {
      const fakeTempad = join(dir, "tempad");
      const argvLog = join(dir, "argv.log");
      writeFileSync(fakeTempad, `#!/bin/sh\necho "$@" >> "${argvLog}"\n`);
      chmodSync(fakeTempad, 0o755);

      const scriptPath = join(import.meta.dir, "../../hooks/w5-stop.sh");

      const spawnHookAndCaptureArgv = async (hookEventName: string) => {
        const proc = Bun.spawn({
          cmd: ["bash", scriptPath],
          env: { ...process.env, TEMPAD_BIN: fakeTempad, TEMPAD_HOME: dir },
          stdin: new Response(JSON.stringify({ session_id: "s1", hook_event_name: hookEventName })),
          stdout: "ignore",
          stderr: "ignore",
        });
        await proc.exited;
      };

      await spawnHookAndCaptureArgv("Stop");
      await spawnHookAndCaptureArgv("SessionEnd");

      const argv = readFileSync(argvLog, "utf8").trim().split("\n");
      expect(argv[0]).toBe("w5 enqueue --session s1 --kind classify");
      expect(argv[1]).toBe("w5 enqueue --session s1 --forced --kind session_end");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("logs loudly and exits 0 when TEMPAD_BIN is unset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-hookscript-test-"));
    try {
      const scriptPath = join(import.meta.dir, "../../hooks/w5-stop.sh");
      const env = { ...process.env, TEMPAD_HOME: dir };
      delete (env as Record<string, string | undefined>).TEMPAD_BIN;

      const proc = Bun.spawn({
        cmd: ["bash", scriptPath],
        env,
        stdin: new Response(JSON.stringify({ session_id: "s1", hook_event_name: "Stop" })),
        stdout: "ignore",
        stderr: "ignore",
      });
      const exitCode = await proc.exited;

      expect(exitCode).toBe(0);
      const logContent = readFileSync(join(dir, "logs", "w5.log"), "utf8");
      expect(logContent).toContain("TEMPAD_BIN not set");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("w5-stop.sh / w5-prompt.sh injection safety", () => {
  test("a malicious session_id is rejected before reaching TEMPAD_BIN, no command execution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-hookscript-test-"));
    try {
      const fakeTempad = join(dir, "tempad");
      const argvLog = join(dir, "argv.log");
      const canaryFile = join(dir, "pwned");
      writeFileSync(fakeTempad, `#!/bin/sh\necho "$@" >> "${argvLog}"\n`);
      chmodSync(fakeTempad, 0o755);

      const scriptPath = join(import.meta.dir, "../../hooks/w5-stop.sh");
      const maliciousSessionId = `s1"; touch ${canaryFile}; echo "`;

      const proc = Bun.spawn({
        cmd: ["bash", scriptPath],
        env: { ...process.env, TEMPAD_BIN: fakeTempad, TEMPAD_HOME: dir },
        stdin: new Response(
          JSON.stringify({ session_id: maliciousSessionId, hook_event_name: "Stop" }),
        ),
        stdout: "ignore",
        stderr: "ignore",
      });
      const exitCode = await proc.exited;

      expect(exitCode).toBe(0);
      expect(existsSync(canaryFile)).toBe(false);
      expect(existsSync(argvLog)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("TEMPAD_BIN containing a semicolon does not execute a second command (no eval)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-hookscript-test-"));
    try {
      const canaryFile = join(dir, "pwned");
      const scriptPath = join(import.meta.dir, "../../hooks/w5-stop.sh");
      const maliciousBin = `true; touch ${canaryFile} #`;

      const proc = Bun.spawn({
        cmd: ["bash", scriptPath],
        env: { ...process.env, TEMPAD_BIN: maliciousBin, TEMPAD_HOME: dir },
        stdin: new Response(JSON.stringify({ session_id: "s1", hook_event_name: "Stop" })),
        stdout: "ignore",
        stderr: "ignore",
      });
      await proc.exited;

      expect(existsSync(canaryFile)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("multi-word TEMPAD_BIN (bun /path/cli.ts style) still works without eval", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tempad-hookscript-test-"));
    try {
      const fakeTempad = join(dir, "fake-bun");
      const argvLog = join(dir, "argv.log");
      writeFileSync(fakeTempad, `#!/bin/sh\nshift\necho "$@" >> "${argvLog}"\n`);
      chmodSync(fakeTempad, 0o755);

      const scriptPath = join(import.meta.dir, "../../hooks/w5-stop.sh");
      const proc = Bun.spawn({
        cmd: ["bash", scriptPath],
        env: { ...process.env, TEMPAD_BIN: `${fakeTempad} /some/cli.ts`, TEMPAD_HOME: dir },
        stdin: new Response(JSON.stringify({ session_id: "s1", hook_event_name: "Stop" })),
        stdout: "ignore",
        stderr: "ignore",
      });
      await proc.exited;

      const argv = readFileSync(argvLog, "utf8").trim();
      expect(argv).toBe("w5 enqueue --session s1 --kind classify");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("verifier hand-back text", () => {
  test("a belongs hand-back lists every active quest, the guess and both answer commands", () => {
    const text = buildBelongsHandback(
      [
        { title: "Ship marko-ui", alias: "Q1" },
        { title: "Fix the flake", alias: "Q2" },
      ],
      "a competitor comparison",
      "Q123",
    );

    expect(text).toBe(
      [
        "w5 thinks the last stretch is not part of your active quests (Ship marko-ui [Q1], Fix the flake [Q2]) (looks like: a competitor comparison). Reply:",
        '  tempad answer Q123 --belongs --why "<reason>"',
        "  or",
        '  tempad answer Q123 --quest <id>|new:"<title>" --why "<reason>" [--origin current --trigger "<sentence>" --kind waiting|blocker|curiosity|unknown]',
        "Ask the user if you are not sure.",
      ].join("\n"),
    );
  });

  test("a belongs hand-back falls back when no quest is active any more", () => {
    const text = buildBelongsHandback([], "a competitor comparison", "Q123");

    expect(text).toContain("not part of your active quests (none)");
  });

  test("a declare hand-back names the session and the declare command", () => {
    const text = buildDeclareHandback("s1");

    expect(text).toBe(
      [
        "w5 has no declared quest for this session. Reply:",
        '  tempad quest declare --session s1 --quest <id>|--new "<title>" --outcome "<text>" [--commitment ...] --by agent',
      ].join("\n"),
    );
  });

  test("buildAdditionalContext renders each verifier kind through its own hand-back", () => {
    const text = buildAdditionalContext(
      [
        {
          id: "Q1",
          traceId: "T1",
          sessionId: "s1",
          kind: "belongs",
          state: "asked",
          turnsWatched: 1,
          turnsAtAsk: 1,
          isSwitch: false,
        },
        {
          id: "Q2",
          traceId: "T2",
          sessionId: "s1",
          kind: "declare",
          state: "asked",
          turnsWatched: 1,
          turnsAtAsk: 1,
          isSwitch: false,
        },
      ],
      {
        activeQuests: [{ title: "Ship marko-ui", alias: "Q1" }],
        sessionId: "s1",
        guessFor: (questionId) => (questionId === "Q1" ? "a competitor comparison" : null),
      },
    );

    expect(text).toContain(
      "not part of your active quests (Ship marko-ui [Q1]) (looks like: a competitor comparison)",
    );
    expect(text).toContain("tempad answer Q1 --belongs");
    expect(text).toContain("w5 has no declared quest for this session");
    expect(text).toContain("tempad quest declare --session s1");
  });
});
