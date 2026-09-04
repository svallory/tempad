import { mondayCollector } from "./monday.ts";
import type { Collector } from "./types.ts";

export const collectors: Map<Collector["name"], Collector> = new Map();
collectors.set(mondayCollector.name, mondayCollector);
