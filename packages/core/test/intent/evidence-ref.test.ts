import { describe, expect, test } from "bun:test";
import { formatEvidenceRef, parseEvidenceRef } from "../../src/intent/evidence-ref";

describe("evidence-ref", () => {
  test("parses a pr ref", () => {
    expect(parseEvidenceRef("pr:Mosaicstg/LiUNA-Campaigns#65")).toEqual({
      kind: "pr",
      repo: "Mosaicstg/LiUNA-Campaigns",
      number: 65,
    });
  });

  test("parses a commit ref", () => {
    expect(parseEvidenceRef("commit:abc1234")).toEqual({ kind: "commit", sha: "abc1234" });
  });

  test("parses a monday ref", () => {
    expect(parseEvidenceRef("monday:123456")).toEqual({ kind: "monday", itemId: "123456" });
  });

  test("rejects an unknown shape", () => {
    expect(() => parseEvidenceRef("issue:42")).toThrow(/invalid evidence ref/);
  });

  test("rejects a pr ref missing the repo slash", () => {
    expect(() => parseEvidenceRef("pr:LiUNA-Campaigns#65")).toThrow(/invalid evidence ref/);
  });

  test("parses a session ref", () => {
    expect(parseEvidenceRef("session:3d4f5a96-77fa-478a-accc-d804f2fad104")).toEqual({
      kind: "session",
      sessionId: "3d4f5a96-77fa-478a-accc-d804f2fad104",
    });
  });

  test("rejects a session ref that is not a UUID", () => {
    expect(() => parseEvidenceRef("session:not-a-uuid")).toThrow(/invalid evidence ref/);
  });

  test("formatEvidenceRef round-trips each shape", () => {
    expect(formatEvidenceRef(parseEvidenceRef("pr:org/repo#1"))).toBe("pr:org/repo#1");
    expect(formatEvidenceRef(parseEvidenceRef("commit:deadbeef"))).toBe("commit:deadbeef");
    expect(formatEvidenceRef(parseEvidenceRef("monday:99"))).toBe("monday:99");
    expect(
      formatEvidenceRef(parseEvidenceRef("session:3d4f5a96-77fa-478a-accc-d804f2fad104")),
    ).toBe("session:3d4f5a96-77fa-478a-accc-d804f2fad104");
  });
});
