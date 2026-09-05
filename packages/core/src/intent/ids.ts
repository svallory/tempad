import { monotonicFactory } from "ulid";

const monotonicUlid = monotonicFactory();

export function newUlid(): string {
  return monotonicUlid();
}

export function isUlid(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}
