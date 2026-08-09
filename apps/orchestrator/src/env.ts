import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * pnpm runs each workspace package with its own cwd, so a bare `dotenv/config`
 * would only ever see apps/orchestrator/.env. Load the workspace root first, then
 * let a package-local .env override it for per-developer settings.
 */
const here = dirname(fileURLToPath(import.meta.url));
for (const path of [
  resolve(here, "../../../.env"), // workspace root
  resolve(here, "../.env"), // apps/orchestrator/.env
]) {
  if (existsSync(path)) loadEnv({ path, override: true });
}

function opt(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}
function num(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
function flag(name: string): boolean {
  return process.env[name] === "1" || process.env[name] === "true";
}

export const env = {
  port: num("PORT", 8080),

  sarvamKey: opt("SARVAM_API_KEY"),

  twilioSid: opt("TWILIO_ACCOUNT_SID"),
  twilioToken: opt("TWILIO_AUTH_TOKEN"),
  twilioFrom: opt("TWILIO_FROM_NUMBER"),
  publicBaseUrl: opt("PUBLIC_BASE_URL").replace(/\/$/, ""),

  supabaseUrl: opt("SUPABASE_URL"),
  supabaseKey: opt("SUPABASE_SERVICE_ROLE_KEY"),

  placesKey: opt("GOOGLE_PLACES_API_KEY"),

  maxParallelCalls: num("MAX_PARALLEL_CALLS", 6),
  ttsModel: opt("TTS_MODEL", "bulbul:v3") as "bulbul:v2" | "bulbul:v3",
  // sarvam-m is deprecated (400s), and sarvam-105b is a reasoning model that
  // returns null content at phone-call token caps. See sarvam/chat.ts.
  negotiateModel: opt("NEGOTIATE_MODEL") || "sarvam-105b-conversations",
  fastModel: opt("FAST_MODEL") || "sarvam-105b-conversations",
  fallbackVad: flag("FALLBACK_VAD"),
  ignoreCallWindow: flag("IGNORE_CALL_WINDOW"),

  ttsDictId: opt("SARVAM_DICT_ID") || undefined,

  /**
   * Test mode. Every call keeps its counterparty's name, language, and persona,
   * but dials this number instead - so you answer and play the shopkeeper while
   * the board shows the real shop. Also the only way to place a genuine PSTN call
   * on a Twilio trial account, which can only dial verified numbers.
   */
  testCallRedirect: opt("TEST_CALL_REDIRECT"),
  testModeDefault: flag("TEST_MODE"),
  /**
   * How many counterparties a test mission actually rings. One by default: you are
   * rehearsing one conversation, not fielding five calls in a row. Raise it to 2-3
   * when you want to rehearse the cross-call leverage beat, which needs a second
   * quote on the bus before it can fire.
   */
  testCallCount: num("TEST_CALL_COUNT", 1),
};

export const has = {
  sarvam: () => Boolean(env.sarvamKey),
  twilio: () => Boolean(env.twilioSid && env.twilioToken && env.twilioFrom && env.publicBaseUrl),
  supabase: () => Boolean(env.supabaseUrl && env.supabaseKey),
  places: () => Boolean(env.placesKey),
};

/** Printed at boot so a missing key is obvious before, not during, the demo. */
export function bootReport(): string[] {
  return [
    `sarvam   ${has.sarvam() ? "ok" : "MISSING - engine cannot speak or think"}`,
    `twilio   ${has.twilio() ? "ok" : "missing - PSTN disabled, sim transport still works"}`,
    `supabase ${has.supabase() ? "ok" : "missing - running in memory only, nothing persists"}`,
    `places   ${has.places() ? "ok" : "missing - discovery falls back to seed CSV + pasted numbers"}`,
  ];
}
