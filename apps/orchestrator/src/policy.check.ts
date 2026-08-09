/**
 * `pnpm policy:check` - regression guard on the calling window.
 *
 * This exists because the first implementation used getTimezoneOffset() arithmetic,
 * which is correct on a UTC server and thirteen hours wrong on an IST laptop. It
 * blocked every call on the one machine the demo runs from, and the error message
 * blamed the clock rather than the code. Run this under several host timezones.
 */
import { withinCallWindow, istMinutes } from "./policy.js";

const CASES: [string, string, boolean][] = [
  ["08:59 IST - one minute early", "2026-08-09T03:29:00Z", false],
  ["09:00 IST - window opens", "2026-08-09T03:30:00Z", true],
  ["14:17 IST - mid afternoon", "2026-08-09T08:47:00Z", true],
  ["20:30 IST - window closes", "2026-08-09T15:00:00Z", true],
  ["20:31 IST - one minute late", "2026-08-09T15:01:00Z", false],
  ["01:30 IST - middle of the night", "2026-08-09T20:00:00Z", false],
];

const hostTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
console.log(`\ncalling window · host timezone ${hostTz}\n`);

let failed = 0;
for (const [label, iso, expected] of CASES) {
  const at = new Date(iso);
  const got = withinCallWindow(at);
  const m = istMinutes(at);
  const clock = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const pass = got === expected;
  if (!pass) failed++;
  console.log(`  ${pass ? "ok  " : "FAIL"}  ${label.padEnd(32)} computed ${clock} IST · allowed=${got}`);
}

console.log(failed ? `\n${failed} case(s) failed.\n` : "\nall cases pass.\n");
process.exit(failed ? 1 : 0);
