import { z } from "zod";

/**
 * A SkillPack is a market, declared as data.
 *
 * Everything downstream derives from this file: composer chips, theater columns,
 * the negotiator's system prompt, savings math, index grouping, and the eval roster.
 * That derivation is the reason a skill beats "just a prompt" - a prompt cannot be
 * validated at boot, hot-loaded, or eval-gated.
 */

/**
 * Speaker rosters, transcribed from the sarvamai@1.1.8 TTS request schema.
 * These are enforced at load time because an invalid speaker does not fail until
 * the first synthesis call - i.e. live, on stage, mid-demo.
 */
export const BULBUL_V2_SPEAKERS = [
  "anushka",
  "manisha",
  "vidya",
  "arya",
  "abhilash",
  "karun",
  "hitesh",
] as const;

export const BULBUL_V3_SPEAKERS = [
  "shubh", "aditya", "ritu", "priya", "neha", "rahul", "pooja", "rohan",
  "simran", "kavya", "amit", "dev", "ishita", "shreya", "ratan", "varun",
  "manan", "sumit", "roopa", "kabir", "aayan", "ashutosh", "advait", "anand",
  "tanya", "tarun", "sunny", "mani", "gokul", "vijay", "shruti", "suhani",
  "mohit", "kavitha", "rehan", "soham", "rupali",
] as const;

export const SPEAKERS_BY_MODEL: Record<string, readonly string[]> = {
  "bulbul:v2": BULBUL_V2_SPEAKERS,
  "bulbul:v3": BULBUL_V3_SPEAKERS,
};

/** Languages the realtime STT model and Bulbul both handle, that we actually staff voices for. */
export const SUPPORTED_LANGS = ["hi-IN", "kn-IN", "ta-IN", "te-IN", "en-IN", "ml-IN", "mr-IN", "bn-IN", "gu-IN", "pa-IN"] as const;
export type Lang = (typeof SUPPORTED_LANGS)[number];

const MissionField = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["text", "int", "date", "enum", "chips"]),
  required: z.boolean().default(false),
  options: z.array(z.string()).optional(),
  placeholder: z.string().optional(),
  default: z.union([z.string(), z.number()]).optional(),
});
export type MissionField = z.infer<typeof MissionField>;

const FactField = z.object({
  type: z.enum(["bool", "int", "string", "enum", "money", "date"]),
  ask_hint: z.string().min(1),
  options: z.array(z.string()).optional(),
  /** Can the negotiator move this number? Drives NEGOTIATE and the reservation check. */
  negotiable: z.boolean().default(false),
  /** Show as a column in table-mode theater. */
  table: z.boolean().default(false),
  /** Feed this field into the public Bhav Index. */
  index: z.boolean().default(false),
});
export type FactField = z.infer<typeof FactField>;

export const SkillPackSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_]+$/, "id must be lowercase snake_case"),
    label: z.string().min(1),
    emoji: z.string().min(1),
    counterparty_kinds: z.array(z.string()).min(1),

    discovery: z.object({
      places_queries: z.array(z.string()).default([]),
      paste_hint: z.string().default("Paste numbers you already have"),
      seed_csv: z.string().optional(),
    }),

    mission_fields: z.array(MissionField).min(1),
    fact_schema: z.record(FactField),

    states: z.object({
      policy_gate: z.boolean().default(false),
      slot_booking: z.boolean().default(false),
      extra: z.array(z.string()).default([]),
    }),

    tactics: z.object({
      anchor_pct: z.number().min(0).max(0.6),
      max_rounds: z.number().int().min(1).max(6),
      concessions: z.array(z.number().min(0).max(1)).min(1),
      leverage_min_delta: z.number().min(0),
      negotiable_fields: z.array(z.string()).min(1),
      /** Safe arithmetic expression over spec.* and bus.*; see engine/formula.ts */
      reservation: z.string().min(1),
    }),

    capabilities: z.object({
      leverage: z.boolean().default(false),
      dedup: z.object({ keys: z.array(z.string()).default([]) }).default({ keys: [] }),
      dead_lead: z.boolean().default(false),
      alt_inventory: z.boolean().default(false),
    }),

    policies: z.object({
      call_cap_s: z.number().int().min(30).max(600),
      extra_rules: z.array(z.string()).default([]),
    }),

    /**
     * Distilled market expertise from the negotiation skill briefs: what an insider
     * knows, what to trade when price stalls, and the counter to each stock
     * objection. Everything here rides in the system prompt, so keep entries short -
     * every token is time-to-first-word on a live call.
     */
    brief: z
      .object({
        knowledge: z.array(z.string()).default([]),
        levers: z.array(z.string()).default([]),
        objections: z.array(z.object({ them: z.string(), move: z.string() })).default([]),
      })
      .default({ knowledge: [], levers: [], objections: [] }),

    persona: z.object({
      style: z.string().min(1),
      honorifics: z.array(z.string()).default([]),
    }),

    tts: z
      .object({
        model: z.enum(["bulbul:v2", "bulbul:v3"]).default("bulbul:v3"),
        pace: z.number().min(0.5).max(2).default(1),
      })
      .default({ model: "bulbul:v3", pace: 1 }),

    voices: z.record(z.string()),

    savings_formula: z.string().min(1),

    ui: z.object({
      mode: z.enum(["ticker", "table"]),
      hero_metric: z.string().min(1),
    }),

    share_copy: z.string().min(1),
    eval_personas: z.array(z.string()).min(1),
  })
  // ---- cross-field checks: the guardrails that make a skill file trustworthy ----
  .superRefine((pack, ctx) => {
    const factKeys = Object.keys(pack.fact_schema);

    for (const f of pack.tactics.negotiable_fields) {
      if (!factKeys.includes(f)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tactics", "negotiable_fields"],
          message: `"${f}" is not a field in fact_schema (have: ${factKeys.join(", ")})`,
        });
      } else if (!pack.fact_schema[f].negotiable) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fact_schema", f, "negotiable"],
          message: `"${f}" is listed in tactics.negotiable_fields but not marked negotiable:true`,
        });
      }
    }

    if (!factKeys.includes(pack.ui.hero_metric)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ui", "hero_metric"],
        message: `hero_metric "${pack.ui.hero_metric}" is not a fact_schema field`,
      });
    }

    if (pack.tactics.concessions.length < pack.tactics.max_rounds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tactics", "concessions"],
        message: `need at least max_rounds (${pack.tactics.max_rounds}) concession steps, got ${pack.tactics.concessions.length}`,
      });
    }

    // The check that saves the demo: a speaker that does not exist on the chosen
    // bulbul version fails at synthesis time, not at boot.
    const roster = SPEAKERS_BY_MODEL[pack.tts.model] ?? [];
    for (const [lang, speaker] of Object.entries(pack.voices)) {
      if (!roster.includes(speaker)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["voices", lang],
          message: `speaker "${speaker}" does not exist on ${pack.tts.model}. Valid: ${roster.join(", ")}`,
        });
      }
    }
    if (!pack.voices["en-IN"]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["voices"],
        message: "en-IN voice is required as the fallback when language detection is uncertain",
      });
    }
  });

export type SkillPack = z.infer<typeof SkillPackSchema>;

/** Fact fields that belong as columns in table-mode theater, in declaration order. */
export function tableColumns(pack: SkillPack): { key: string; label: string; type: FactField["type"] }[] {
  return Object.entries(pack.fact_schema)
    .filter(([, f]) => f.table)
    .map(([key, f]) => ({ key, label: humanize(key), type: f.type }));
}

/** Fact fields published to the Bhav Index. */
export function indexedFields(pack: SkillPack): string[] {
  return Object.entries(pack.fact_schema)
    .filter(([, f]) => f.index)
    .map(([key]) => key);
}

export function humanize(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
