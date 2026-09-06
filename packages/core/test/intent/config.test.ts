import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultIntentConfig, loadIntentConfig } from "../../src/intent/config";

describe("intent config", () => {
  test("parses hero, parties, clients and w5 with defaults", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-intent-"));
    const path = join(directory, "tempad.toml");
    writeFileSync(
      path,
      `
[hero]
name = "Saulo"
[[parties]]
slug = "mosaic"
name = "Mosaic"
joined = "2025-07-01"
[[clients]]
slug = "liuna"
name = "LiUNA"
[w5]
throttle_minutes = 5
`,
    );
    const config = loadIntentConfig(path);
    expect(config.hero?.name).toBe("Saulo");
    expect(config.parties[0]?.slug).toBe("mosaic");
    expect(config.clients[0]?.name).toBe("LiUNA");
    expect(config.w5.throttleMinutes).toBe(5);
    expect(config.w5.watchTurns).toBe(3);
    expect(config.w5.backfillDays).toBe(15);
    expect(config.w5.backend).toBe("claude-cli");
    expect(config.w5.claudeCommand).toBe("claude");
    expect(config.w5.timeoutSeconds).toBe(180);
    expect(config.w5.activityIdleMinutes).toBe(45);
    expect(config.w5.memoryHours).toBe(8);
    expect(config.w5.memoryActivities).toBe(10);
    expect(config.w5.overlapMessages).toBe(3);
  });

  test("parses activity_idle_minutes, memory_hours, memory_activities, overlap_messages", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-intent-"));
    const path = join(directory, "tempad.toml");
    writeFileSync(
      path,
      `
[w5]
activity_idle_minutes = 30
memory_hours = 4
memory_activities = 5
overlap_messages = 2
`,
    );
    const config = loadIntentConfig(path);
    expect(config.w5.activityIdleMinutes).toBe(30);
    expect(config.w5.memoryHours).toBe(4);
    expect(config.w5.memoryActivities).toBe(5);
    expect(config.w5.overlapMessages).toBe(2);
  });

  test("defaultIntentConfig().w5 has the activity lifecycle defaults", () => {
    const config = defaultIntentConfig();
    expect(config.w5.activityIdleMinutes).toBe(45);
    expect(config.w5.memoryHours).toBe(8);
    expect(config.w5.memoryActivities).toBe(10);
    expect(config.w5.overlapMessages).toBe(3);
  });

  test("parses w5 timeout_seconds", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-intent-"));
    const path = join(directory, "tempad.toml");
    writeFileSync(path, `[w5]\ntimeout_seconds = 60\n`);
    const config = loadIntentConfig(path);
    expect(config.w5.timeoutSeconds).toBe(60);
  });

  test("parses w5 backend and claude_command", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-intent-"));
    const path = join(directory, "tempad.toml");
    writeFileSync(
      path,
      `
[w5]
backend = "api"
claude_command = "/opt/bin/claude"
`,
    );
    const config = loadIntentConfig(path);
    expect(config.w5.backend).toBe("api");
    expect(config.w5.claudeCommand).toBe("/opt/bin/claude");
  });

  test("falls back to default backend on unknown value", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-intent-"));
    const path = join(directory, "tempad.toml");
    writeFileSync(path, `[w5]\nbackend = "bogus"\n`);
    const config = loadIntentConfig(path);
    expect(config.w5.backend).toBe("claude-cli");
  });

  test("defaultIntentConfig reflects claude-cli defaults", () => {
    const config = defaultIntentConfig();
    expect(config.w5.backend).toBe("claude-cli");
    expect(config.w5.claudeCommand).toBe("claude");
  });

  test("rejects a party without slug", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-intent-"));
    const path = join(directory, "tempad.toml");
    writeFileSync(path, `[[parties]]\nname = "x"\n`);
    expect(() => loadIntentConfig(path)).toThrow(/slug/);
  });

  test("a missing tempad.toml returns defaultIntentConfig instead of crashing (first-run hero init)", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-intent-"));
    const path = join(directory, "tempad.toml");
    // deliberately do not create the file
    const config = loadIntentConfig(path);
    expect(config).toEqual(defaultIntentConfig());
  });
});
