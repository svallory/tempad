export function heading(level: number, text: string): string {
  return `${"#".repeat(level)} ${text}`;
}

export function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function table(headers: string[], rows: string[][]): string {
  const headerLine = `| ${headers.map(escapeCell).join(" | ")} |`;
  const separatorLine = `| ${headers.map(() => "---").join(" | ")} |`;
  const rowLines = rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`);
  return [headerLine, separatorLine, ...rowLines].join("\n");
}

const dayFormatterCache = new Map<string, Intl.DateTimeFormat>();
const hourFormatterCache = new Map<string, Intl.DateTimeFormat>();
const weekdayFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getDayFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = dayFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dayFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function getHourFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = hourFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    hourFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function getWeekdayFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = weekdayFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
    });
    weekdayFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Local calendar day (YYYY-MM-DD) for an ISO instant, per the given IANA zone. */
export function localDay(isoTimestamp: string, timeZone: string): string {
  return getDayFormatter(timeZone).format(new Date(isoTimestamp));
}

/** Local hour bucket (0-23) for an ISO instant, per the given IANA zone. */
export function localHour(isoTimestamp: string, timeZone: string): number {
  const parts = getHourFormatter(timeZone).formatToParts(new Date(isoTimestamp));
  const hourPart = parts.find((part) => part.type === "hour");
  if (!hourPart) throw new Error("Failed to extract hour from formatted timestamp");
  const hour = Number.parseInt(hourPart.value, 10);
  return hour === 24 ? 0 : hour;
}

/** Local "HH:MM" for an ISO instant, per the given IANA zone. */
export function localTime(isoTimestamp: string, timeZone: string): string {
  const formatted = getHourFormatter(timeZone).format(new Date(isoTimestamp));
  return formatted === "24:00" ? "00:00" : formatted;
}

/**
 * Local "YYYY-MM-DD HH:MM" for an ISO instant, per the given IANA zone. A bare
 * date (no "T", e.g. a Monday timeline_start/end with no time component) is
 * returned unchanged -- there is no instant to convert.
 */
export function localDateTime(timestamp: string, timeZone: string): string {
  if (!timestamp.includes("T")) return timestamp;
  return `${localDay(timestamp, timeZone)} ${localTime(timestamp, timeZone)}`;
}

export function localWeekday(day: string, timeZone: string): string {
  const [year, month, date] = day.split("-").map(Number);
  const noonUtc = new Date(Date.UTC(year as number, (month as number) - 1, date, 12));
  return getWeekdayFormatter(timeZone).format(noonUtc);
}

export function isWeekend(day: string, timeZone: string): boolean {
  const weekday = localWeekday(day, timeZone);
  return weekday === "Saturday" || weekday === "Sunday";
}

const offsetFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getOffsetFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = offsetFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" });
    offsetFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** UTC offset in minutes (east positive) the zone observes at the given instant. */
function offsetMinutesAt(instantMs: number, timeZone: string): number {
  const parts = getOffsetFormatter(timeZone).formatToParts(new Date(instantMs));
  const offsetPart = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT+0";
  const match = offsetPart.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number.parseInt(match[2] as string, 10);
  const minutes = match[3] ? Number.parseInt(match[3], 10) : 0;
  return sign * (hours * 60 + minutes);
}

/** UTC instant (ISO) of local midnight for `day` (YYYY-MM-DD) in the given IANA zone. */
export function utcInstantForLocalMidnight(day: string, timeZone: string): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const utcMidnight = Date.UTC(year, month - 1, date);
  const offsetMinutes = offsetMinutesAt(utcMidnight, timeZone);
  // Local midnight = UTC midnight minus the zone's eastward offset.
  return new Date(utcMidnight - offsetMinutes * 60 * 1000).toISOString();
}

/** [start, end) UTC instants (ISO) covering the local day `day` in `timeZone`. */
export function localDayBoundsUtc(day: string, timeZone: string): { start: string; end: string } {
  const start = utcInstantForLocalMidnight(day, timeZone);
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const nextDayDate = new Date(Date.UTC(year, month - 1, date + 1));
  const nextDay = `${nextDayDate.getUTCFullYear()}-${String(nextDayDate.getUTCMonth() + 1).padStart(2, "0")}-${String(nextDayDate.getUTCDate()).padStart(2, "0")}`;
  const end = utcInstantForLocalMidnight(nextDay, timeZone);
  return { start, end };
}

/** Inclusive list of YYYY-MM-DD local days from `from` to `to`. */
export function dayRange(from: string, to: string): string[] {
  const days: string[] = [];
  const [fromYear, fromMonth, fromDate] = from.split("-").map(Number);
  const [toYear, toMonth, toDate] = to.split("-").map(Number);
  let cursor = Date.UTC(fromYear as number, (fromMonth as number) - 1, fromDate);
  const end = Date.UTC(toYear as number, (toMonth as number) - 1, toDate);

  while (cursor <= end) {
    const date = new Date(cursor);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    days.push(`${year}-${month}-${day}`);
    cursor += 24 * 60 * 60 * 1000;
  }

  return days;
}

export function elapsedLabel(fromIso: string, toIso: string): string {
  const totalMinutes = Math.max(
    0,
    Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60000),
  );
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}
