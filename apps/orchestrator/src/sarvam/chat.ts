import { sarvam } from "./client.js";
import { env } from "../env.js";
import { log } from "../log.js";
import { mockChat, mockEnabled } from "./mock.js";

/**
 * The negotiation brain.
 *
 * sarvamai@1.1.8 exposes `response_format: { type: "json_schema", ... }`, so the
 * turn contract is guaranteed by the API rather than begged for in the prompt.
 * That turns the "JSON validity 100%" eval gate from something we hope for into
 * something the transport enforces - and it removes the retry loop from the hot path.
 */

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ChatOpts = {
  messages: ChatMessage[];
  /** Structured output schema. Omit for free text. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  /** Negotiation turns get the bigger model; everything else takes the fast one. */
  heavy?: boolean;
  temperature?: number;
  maxTokens?: number;
  label?: string;
};

/** Rolling latency samples, surfaced on /stats for the technical-depth slide. */
export const turnLatency: number[] = [];

export async function chat<T = unknown>(opts: ChatOpts): Promise<{ value: T; raw: string; ms: number; model: string }> {
  const model = opts.heavy ? env.negotiateModel : env.fastModel;
  const started = Date.now();

  if (mockEnabled()) {
    const value = mockChat(opts.messages, opts.jsonSchema?.name) as T;
    const ms = Date.now() - started;
    return { value, raw: JSON.stringify(value), ms, model: `mock/${model}` };
  }

  const res = await sarvam().chat.completions({
    model: model as never,
    messages: opts.messages as never,
    temperature: opts.temperature ?? 0.5,
    max_tokens: opts.maxTokens ?? 320,
    ...(opts.heavy ? { reasoning_effort: "low" as never } : {}),
    ...(opts.jsonSchema
      ? {
          response_format: {
            type: "json_schema",
            json_schema: { name: opts.jsonSchema.name, schema: opts.jsonSchema.schema, strict: true },
          } as never,
        }
      : {}),
  });

  const ms = Date.now() - started;
  turnLatency.push(ms);
  if (turnLatency.length > 200) turnLatency.shift();

  const raw = (res as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "";
  log.info(`chat ${opts.label ?? ""} ${model} ${ms}ms ${raw.length}ch`);

  if (!opts.jsonSchema) return { value: raw as T, raw, ms, model };

  return { value: parseJson<T>(raw), raw, ms, model };
}

/**
 * Structured outputs make this near-redundant, but a model behind a proxy can still
 * wrap JSON in a fence. Salvaging is cheaper than losing a turn on a live call.
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

export function latencyP95(): number | null {
  if (!turnLatency.length) return null;
  const sorted = [...turnLatency].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1];
}
