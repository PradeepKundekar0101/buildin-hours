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

const IST = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/**
 * Wall-clock time in India, whatever the host machine thinks the time is.
 *
 * Doing this with getTimezoneOffset() arithmetic is a trap: the obvious formula
 * happens to work on a UTC server and is thirteen hours wrong on a laptop that is
 * already in IST, which is exactly the machine you demo from. Intl knows the
 * offset; we should not be recomputing it.
 */
export function istMinutes(now = new Date()): number {
  const [h, m] = IST.format(now).split(":").map(Number);
  return h * 60 + m;
}

/** Calling a shop at 2am is how a demo becomes a complaint. IST 09:00-20:30. */
export function withinCallWindow(now = new Date()): boolean {
  if (env.ignoreCallWindow) return true;
  const minutes = istMinutes(now);
  return minutes >= 9 * 60 && minutes <= 20 * 60 + 30;
}

export function callWindowMessage(now = new Date()): string {
  const m = istMinutes(now);
  const clock = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return `It is ${clock} IST, outside the 09:00-20:30 calling window. Set IGNORE_CALL_WINDOW=1 for rehearsal, or run in sim mode.`;
}
