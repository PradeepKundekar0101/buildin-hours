import { sarvam } from "./client.js";
import { env } from "../env.js";
import { log } from "../log.js";
import { mockAudio, mockEnabled } from "./mock.js";
import type { SkillPack } from "../skills/schema.js";

/**
 * Bulbul -> Twilio with zero transcode.
 *
 * Verified against sarvamai@1.1.8: `output_audio_codec: "mulaw"` and
 * `speech_sample_rate: 8000` are both accepted, which is exactly what a Twilio
 * Media Stream wants on the wire. There is no resampling or codec conversion
 * anywhere in this path.
 */

export type SpeakOptions = {
  text: string;
  lang: string;
  pack: SkillPack;
  /** Cache the result keyed by text+voice. Use for openers, fillers, and closers. */
  cacheable?: boolean;
};

const cache = new Map<string, Buffer>();

/** Sarvam pronounces long digit strings better when they are comma grouped. */
export function groupNumbers(text: string): string {
  return text.replace(/\b\d{5,}\b/g, (n) => Number(n).toLocaleString("en-IN"));
}

function speakerFor(pack: SkillPack, lang: string): string {
  return pack.voices[lang] ?? pack.voices["en-IN"];
}

/**
 * The TTS response is base64. If the account returns a WAV container despite the
 * mulaw codec request, strip the header so Twilio never receives RIFF bytes as audio.
 */
function toRawMulaw(b64: string): Buffer {
  const buf = Buffer.from(b64, "base64");
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF") {
    // Walk the RIFF chunks to find `data` rather than assuming a 44-byte header.
    let off = 12;
    while (off + 8 <= buf.length) {
      const id = buf.toString("ascii", off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (id === "data") return buf.subarray(off + 8, Math.min(off + 8 + size, buf.length));
      off += 8 + size + (size % 2);
    }
    return buf.subarray(44);
  }
  return buf;
}

export async function synthesize(opts: SpeakOptions): Promise<Buffer> {
  if (mockEnabled()) return mockAudio();
  const { pack, lang } = opts;
  const speaker = speakerFor(pack, lang);
  const text = groupNumbers(opts.text.trim());
  const key = `${pack.tts.model}|${speaker}|${lang}|${text}`;

  if (opts.cacheable) {
    const hit = cache.get(key);
    if (hit) return hit;
  }

  const started = Date.now();
  const res = await sarvam().textToSpeech.convert({
    text,
    language_code: lang as never,
    speaker: speaker as never,
    model: (pack.tts.model ?? env.ttsModel) as never,
    output_audio_codec: "mulaw" as never,
    speech_sample_rate: 8000 as never,
    pace: pack.tts.pace,
    // dict_id locks SKU and brand pronunciation. bulbul:v3 only.
    ...(env.ttsDictId && pack.tts.model === "bulbul:v3" ? { dict_id: env.ttsDictId } : {}),
    // Sarvam-side caching is beta and v1/v2 only; we keep our own map for v3.
    ...(pack.tts.model === "bulbul:v2" ? { enable_cached_responses: true } : {}),
  });

  const b64 = (res as { audios?: string[] }).audios?.[0];
  if (!b64) throw new Error("TTS returned no audio");

  const raw = toRawMulaw(b64);
  log.info(`tts ${Date.now() - started}ms ${raw.length}B ${speaker}/${lang} "${text.slice(0, 40)}"`);

  if (opts.cacheable) cache.set(key, raw);
  return raw;
}

/**
 * Pre-synthesise the lines we know we will say, so the first audible second of a
 * call costs nothing. Called once per mission before dialling.
 */
export async function warmFillers(pack: SkillPack, langs: string[]): Promise<void> {
  const lines: Record<string, string[]> = {
    "hi-IN": ["Ek second ji.", "Achha, samajh gaya.", "Ji, sun raha hoon."],
    "en-IN": ["One second please.", "Got it.", "Okay, understood."],
    "kn-IN": ["Ondu nimisha.", "Sari, artha aaytu."],
    "ta-IN": ["Oru nimisham.", "Sari, purinjuchu."],
    "te-IN": ["Oka nimisham.", "Sare, artham ayindi."],
  };
  const jobs: Promise<unknown>[] = [];
  for (const lang of langs) {
    for (const text of lines[lang] ?? lines["en-IN"]) {
      jobs.push(
        synthesize({ text, lang, pack, cacheable: true }).catch((e) =>
          log.warn(`filler warm failed ${lang}: ${e instanceof Error ? e.message : e}`)
        )
      );
    }
  }
  await Promise.all(jobs);
}

export function fillerFor(lang: string): string {
  const map: Record<string, string> = {
    "hi-IN": "Ek second ji.",
    "kn-IN": "Ondu nimisha.",
    "ta-IN": "Oru nimisham.",
    "te-IN": "Oka nimisham.",
    "en-IN": "One second please.",
  };
  return map[lang] ?? map["en-IN"];
}
