import { env } from "./env.js";

/**
 * The rules that keep this legal and decent. They are engine-level, not skill-level,
 * because no market gets to opt out of them.
 */

const optOut = new Set<string>();

export function isOptedOut(phone: string): boolean {
  return optOut.has(phone);
}

export function addOptOut(phone: string): void {
  optOut.add(phone);
}

export function optOutList(): string[] {
  return [...optOut];
}

/** Calling a shop at 2am is how a demo becomes a complaint. IST 09:00-20:30. */
export function withinCallWindow(now = new Date()): boolean {
  if (env.ignoreCallWindow) return true;
  const ist = new Date(now.getTime() + (5.5 * 60 - now.getTimezoneOffset()) * 60_000);
  const minutes = ist.getHours() * 60 + ist.getMinutes();
  return minutes >= 9 * 60 && minutes <= 20 * 60 + 30;
}

export function callWindowMessage(): string {
  return "Outside the 09:00-20:30 IST calling window. Set IGNORE_CALL_WINDOW=1 for rehearsal, or run in sim mode.";
}
