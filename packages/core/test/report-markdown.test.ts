import { describe, expect, test } from "bun:test";
import {
  dayRange,
  escapeCell,
  isWeekend,
  localDay,
  localHour,
  localTime,
  table,
} from "../src/report/markdown.ts";

describe("markdown helpers", () => {
  test("table escapes pipes in cells", () => {
    const rendered = table(["a", "b"], [["x|y", "z"]]);
    expect(rendered).toBe("| a | b |\n| --- | --- |\n| x\\|y | z |");
  });

  test("escapeCell collapses newlines", () => {
    expect(escapeCell("line1\nline2")).toBe("line1 line2");
  });

  test("localDay places a UTC instant on the correct local day across the timezone boundary", () => {
    expect(localDay("2026-09-01T02:30:00.000Z", "America/Sao_Paulo")).toBe("2026-08-31");
    expect(localDay("2026-09-01T03:00:00.000Z", "America/Sao_Paulo")).toBe("2026-09-01");
  });

  test("localHour and localTime agree with the local offset", () => {
    expect(localHour("2026-09-01T14:00:00.000Z", "America/Sao_Paulo")).toBe(11);
    expect(localTime("2026-09-01T14:00:00.000Z", "America/Sao_Paulo")).toBe("11:00");
  });

  test("isWeekend recognizes Saturday and Sunday, not weekdays", () => {
    expect(isWeekend("2026-09-05", "America/Sao_Paulo")).toBe(true); // Saturday
    expect(isWeekend("2026-09-06", "America/Sao_Paulo")).toBe(true); // Sunday
    expect(isWeekend("2026-09-04", "America/Sao_Paulo")).toBe(false); // Friday
  });

  test("dayRange is inclusive on both ends", () => {
    expect(dayRange("2026-08-31", "2026-09-02")).toEqual([
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
    ]);
  });
});
