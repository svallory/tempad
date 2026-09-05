import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIntentConfig } from "../../src/intent/config";

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
  });

  test("rejects a party without slug", () => {
    const directory = mkdtempSync(join(tmpdir(), "tempad-intent-"));
    const path = join(directory, "tempad.toml");
    writeFileSync(path, `[[parties]]\nname = "x"\n`);
    expect(() => loadIntentConfig(path)).toThrow(/slug/);
  });
});
