import { sarvam } from "./client.js";
import { env } from "../env.js";
import { log } from "../log.js";
import { mockChat, mockEnabled } from "./mock.js";

/**
 * The negotiation brain.
 *
 * Measured against the live API rather than the SDK's type surface:
 *
 *   - `sarvam-m` is deprecated and 400s. Only `sarvam-105b` and
 *     `sarvam-105b-conversations` exist.
 *   - `sarvam-105b` is a reasoning model. It spends its whole token budget
 *     thinking and returns `content: null` at any cap short enough for a phone
 *     call, so it is unusable for turns.
 *   - `response_format: { type: "json_schema" }` is degenerate: the model emits a
 *     valid object then floods whitespace until it hits the cap, producing invalid
 *     JSON after ~13 seconds.
 *   - `response_format: { type: "json_object" }` works: valid JSON, finish_reason
 *     "stop", around two seconds.
 *
 * So the contract is json_object plus an explicit shape line in the prompt, and
 * `parseJson` below stays load-bearing rather than being belt-and-braces.
 */

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ChatOpts = {
  messages: ChatMessage[];
  /**
   * Ask for JSON. `shape` is a literal example object appended to the system
   * message - the model never sees a JSON Schema, so descriptions have to be here.
   */
  json?: {
    name: string;
    shape: string;
    /** The field a keyless reply should be read as - see salvageKeyless. */
    primaryKey: string;
  };
  /**
   * Fires the moment the primaryKey's string value is complete in the stream -
   * long before the rest of the object finishes decoding. This is what lets a
   * call start speaking at "time to first sentence" instead of "time to full
   * contract": on a ~100 chars/sec model that is seconds of dead air recovered.
   * Fires at most once per chat() call, even across the internal retry.
   */
  onPrimaryValue?: (text: string) => void;
  /** Negotiation turns may use a different model; both default to the same one. */
  heavy?: boolean;
  temperature?: number;
  maxTokens?: number;
  label?: string;
};

/** Rolling latency samples, surfaced on /stats for the technical-depth slide. */
export const turnLatency: number[] = [];

/**
 * True once `raw` contains one complete, balanced JSON object. Used to cut a
 * streaming response the moment the contract is in hand - the whitespace flood
 * that follows costs seconds of dead air on a live call and carries nothing.
 */
export function jsonObjectComplete(raw: string): boolean {
  const start = raw.indexOf("{");
  if (start < 0) return false;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\") {
      escaped = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return true;
    }
  }
  return false;
}

/**
 * One streamed completion, cut short as soon as the JSON object closes.
 *
 * Measured live on 9 Aug 2026: the model decodes at roughly 100 chars/sec, so a
 * full ~450-char turn contract costs ~4.5s on top of ~2s to first token. Streaming
 * buys two things a non-streaming request cannot:
 *   - the whitespace flood (about one turn in five) is cut at the closing brace
 *     instead of running to the token cap;
 *   - the primaryKey watcher fires while the tail of the object is still decoding,
 *     so the call starts speaking seconds before the contract finishes.
 * (`reasoning_effort` was A/B tested the same day: no effect on this model.)
 */
async function completeStreaming(args: {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  json: boolean;
  /** Watch the stream for `"<primaryKey>": "..."` and fire the moment it closes. */
  primaryKey?: string;
  onPrimaryValue?: (text: string) => void;
}): Promise<string> {
  const controller = new AbortController();
  const stream = await sarvam().chat.completions(
    {
      model: args.model as never,
      messages: args.messages as never,
      temperature: args.temperature,
      max_tokens: args.maxTokens,
      stream: true,
      ...(args.json ? { response_format: { type: "json_object" } as never } : {}),
    },
    { abortSignal: controller.signal }
  );

  const primaryRe =
    args.primaryKey && args.onPrimaryValue
      ? new RegExp(`"${args.primaryKey}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)
      : null;
  let primaryFired = false;

  let raw = "";
  try {
    for await (const chunk of stream) {
      raw += (chunk as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content ?? "";

      if (primaryRe && !primaryFired) {
        const m = raw.match(primaryRe);
        if (m) {
          primaryFired = true;
          const value = m[1].replace(/\\(["\\/bfnrt])/g, (_, c) =>
            c === "n" ? "\n" : c === "t" ? "\t" : c === "b" || c === "f" || c === "r" ? " " : c
          );
          if (value.trim()) args.onPrimaryValue!(value.trim());
        }
      }

      if (args.json && jsonObjectComplete(raw)) {
        controller.abort();
        break;
      }
    }
  } catch (err) {
    // Our own abort surfaces as an error inside the iterator; anything else is real.
    if (!controller.signal.aborted) throw err;
  }
  return raw;
}

export async function chat<T = unknown>(opts: ChatOpts): Promise<{ value: T; raw: string; ms: number; model: string }> {
  const model = opts.heavy ? env.negotiateModel : env.fastModel;
  const started = Date.now();

  if (mockEnabled()) {
    const value = mockChat(opts.messages, opts.json?.name) as T;
    const ms = Date.now() - started;
    return { value, raw: JSON.stringify(value), ms, model: `mock/${model}` };
  }

  // The shape rides in the system message because json_object mode carries no schema.
  const messages = opts.json
    ? opts.messages.map((m, i) =>
        i === 0 && m.role === "system"
          ? { ...m, content: `${m.content}\n\nReturn ONLY this JSON object, nothing before or after it:\n${opts.json!.shape}` }
          : m
      )
    : opts.messages;

  // At most one early-speech trigger per turn, even if the retry also matches.
  let primaryFired = false;
  const onPrimaryValue = opts.onPrimaryValue
    ? (text: string) => {
        if (primaryFired) return;
        primaryFired = true;
        opts.onPrimaryValue!(text);
      }
    : undefined;

  const raw = await completeStreaming({
    model,
    messages: messages as ChatMessage[],
    temperature: opts.temperature ?? 0.5,
    maxTokens: opts.maxTokens ?? 320,
    json: Boolean(opts.json),
    primaryKey: opts.json?.primaryKey,
    onPrimaryValue,
  });

  const ms = Date.now() - started;
  turnLatency.push(ms);
  if (turnLatency.length > 200) turnLatency.shift();

  log.info(`chat ${opts.label ?? ""} ${model} ${ms}ms ${raw.length}ch`);

  if (!opts.json) return { value: raw as T, raw, ms, model };

  try {
    return { value: parseJson<T>(raw), raw, ms, model };
  } catch {
    // Roughly one turn in five, the model writes a good object and then floods
    // whitespace until it hits the cap. The words we need are already in hand, so
    // salvage FIRST - a retry costs another two seconds on a live call, and the
    // caller is sitting there listening to silence.
    const early = repairJson<T>(raw) ?? salvageKeyless<T>(raw, opts.json.primaryKey);
    if (early) {
      log.warn(`chat ${opts.label ?? ""} salvaged without a retry (${ms}ms)`);
      return { value: early, raw, ms, model };
    }

    log.warn(`chat ${opts.label ?? ""} returned unusable JSON (${raw.length}ch), retrying once`);

    const retryRaw = await completeStreaming({
      model,
      messages: [
        ...(messages as ChatMessage[]),
        {
          role: "system" as const,
          content: "Your previous reply was not valid JSON. Reply with the JSON object only, on a single line, no blank lines.",
        },
      ],
      temperature: 0.2,
      maxTokens: opts.maxTokens ?? 320,
      json: true,
      primaryKey: opts.json.primaryKey,
      onPrimaryValue,
    });
    const totalMs = Date.now() - started;

    try {
      return { value: parseJson<T>(retryRaw), raw: retryRaw, ms: totalMs, model };
    } catch {
      const key = opts.json.primaryKey;
      const salvaged =
        repairJson<T>(retryRaw) ?? repairJson<T>(raw) ?? salvageKeyless<T>(retryRaw, key) ?? salvageKeyless<T>(raw, key);
      if (salvaged) {
        log.warn(`chat ${opts.label ?? ""} salvaged a truncated object`);
        return { value: salvaged, raw: retryRaw || raw, ms: totalMs, model };
      }
      throw new Error(`model did not return JSON after a retry: ${JSON.stringify(raw.slice(0, 120))}`);
    }
  }
}

/**
 * Close an object the model started but never finished. Returns null when there is
 * nothing worth keeping - an empty shell is worse than a clean failure, because it
 * would put an empty sentence on a live phone line.
 */
export function repairJson<T>(raw: string): T | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;

  let out = "";
  let inString = false;
  let escaped = false;
  const stack: string[] = [];

  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    out += c;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\") {
      escaped = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") stack.pop();
  }

  if (inString) out += '"';
  out = out.replace(/,\s*$/, "");
  while (stack.length) out += stack.pop();

  try {
    const parsed = JSON.parse(out) as T;
    // A bare {} means the flood ate everything; treat that as a failure.
    if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * json_object guarantees the model intends JSON, not that what arrives parses -
 * fences, leading newlines, and trailing prose all still happen. Salvaging is far
 * cheaper than losing a turn on a live call.
 */
export function parseJson<T>(raw: string): T {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1)) as T;
    }
    throw new Error(`model did not return JSON: ${raw.slice(0, 200)}`);
  }
}

/**
 * The dominant tail failure, once retries are in place: the model writes the
 * sentence but forgets the key, giving `{ "Yeh price abhi valid hai." }` - or wraps
 * a whole Python-style dict in a string. In both cases the words we need are right
 * there, so throwing them away and going silent on a live call would be perverse.
 */
export function salvageKeyless<T>(raw: string, primaryKey: string): T | null {
  const open = raw.indexOf("{");
  if (open < 0) return null;

  const first = raw.slice(open + 1).match(/"((?:[^"\\]|\\.)*)"/);
  if (!first) return null;

  const inner = first[1].replace(/\\"/g, '"').trim();

  // Case: the model stringified the entire object, often with single quotes.
  if (inner.startsWith("{") && inner.includes(":")) {
    const normalised = inner
      .replace(/'/g, '"')
      .replace(/\bTrue\b/g, "true")
      .replace(/\bFalse\b/g, "false")
      .replace(/\bNone\b/g, "null");
    try {
      const parsed = JSON.parse(normalised) as T;
      if (parsed && typeof parsed === "object" && Object.keys(parsed).length) return parsed;
    } catch {
      /* fall through to treating it as plain text */
    }
  }

  if (!inner || inner.length < 2) return null;
  return { [primaryKey]: inner } as T;
}

export function latencyP95(): number | null {
  if (!turnLatency.length) return null;
  const sorted = [...turnLatency].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1];
}
