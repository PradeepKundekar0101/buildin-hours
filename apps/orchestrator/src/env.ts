import "dotenv/config";

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
  negotiateModel: opt("NEGOTIATE_MODEL", "sarvam-105b"),
  fastModel: opt("FAST_MODEL", "sarvam-m"),
  fallbackVad: flag("FALLBACK_VAD"),
  ignoreCallWindow: flag("IGNORE_CALL_WINDOW"),

  ttsDictId: opt("SARVAM_DICT_ID") || undefined,
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
