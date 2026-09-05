import { ulid } from "ulid";

export function newUlid(): string {
  return ulid();
}

export function isUlid(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}
