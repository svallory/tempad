import { dailyReport } from "./daily.ts";
import { hourlyReport } from "./hourly.ts";
import { projectReport } from "./project.ts";
import type { Report } from "./types.ts";

export const reports: Map<Report["kind"], Report> = new Map([
  [dailyReport.kind, dailyReport],
  [projectReport.kind, projectReport],
  [hourlyReport.kind, hourlyReport],
]);
