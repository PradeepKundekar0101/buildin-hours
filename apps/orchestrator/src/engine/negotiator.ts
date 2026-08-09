import { chat } from "../sarvam/chat.js";
import type { SkillPack } from "../skills/schema.js";
import { systemCore, turnContext } from "./prompts.js";
import { evaluateFormula } from "./formula.js";
import type { FactBus } from "./fact-bus.js";
import { STATES, type CallRecord, type Mission, type State, type TurnContract } from "./types.js";
import { log } from "../log.js";

/**
 * The negotiation core. Transport-agnostic on purpose: it never learns whether the
 * far end is a PSTN line or the simulator, which is what lets the eval harness
 * exercise the exact code path that runs on stage.
 */

/**
 * The turn contract, written as a literal example.
 *
 * Sarvam's json_object mode carries no schema, so every constraint that used to
 * live in a JSON Schema `description` has to be visible right here or the model
 * never learns it. That is not a downgrade in practice - the first live probe
 * against a real schema returned `"lang": " Hinglish"`, because the model was
 * never shown the enum it was supposedly constrained to.
 */
export function contractShape(pack: SkillPack, langs: string[]): string {
  const facts = Object.entries(pack.fact_schema)
    .map(([key, f]) => {
      const t =
        f.type === "money" || f.type === "int" ? "number|null" : f.type === "bool" ? "true|false|null" : "string|null";
      return `    "${key}": ${t}   // ${f.ask_hint}`;
    })
    .join("\n");

  return [
    "{",
    '  "say": "string, at most 26 words, in the language you are speaking",',
    `  "lang": "one of: ${langs.join(" | ")}",`,
    `  "next_state": "one of: ${STATES.join(" | ")}",`,
    '  "facts_delta": {   // ONLY keys you learned this turn. OMIT keys you did not learn - do not write null',
    facts,
    "  },",
    '  "signals": { "mood": "warm|neutral|busy|hostile", "asked_if_bot": true|false, "wants_end": true|false },',
    '  "end_call": true|false,',
    '  "note": "string, at most 12 words, for the operator log"',
    "}",
  ].join("\n");
}

/**
 * Resolve `tactics.reservation` against live data.
 * Returns null when the formula needs a bus number we do not have yet - the
 * prompt then falls back to the customer's budget, which is always safe.
 */
export function resolveReservation(args: {
  pack: SkillPack;
  mission: Mission;
  bus: FactBus;
  cpId: string;
}): { value: number | null; missing: string[] } {
  const best = args.bus.bestExternal(args.cpId);
  const vars: Record<string, number | null> = {
    "bus.best_external": best?.value ?? null,
    "bus.first_quote_max": args.bus.firstQuoteMax(),
  };
  for (const [k, v] of Object.entries(args.mission.spec)) {
    const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.-]/g, ""));
    vars[`spec.${k}`] = Number.isFinite(n) ? n : null;
  }
  const { value, missing } = evaluateFormula(args.pack.tactics.reservation, vars);

  if (value === null) {
    // Fall back to the first numeric budget-ish field in the spec.
    const fallbackKey = Object.keys(vars).find((k) => /budget|target/.test(k) && vars[k] !== null);
    return { value: fallbackKey ? vars[fallbackKey] : null, missing };
  }
  return { value, missing };
}

/** Which state to force, regardless of what the model wants, when an interrupt fires. */
function applyInterrupts(contract: TurnContract): TurnContract {
  if (contract.signals.wants_end) {
    return { ...contract, next_state: "WRAP", end_call: true };
  }
  return contract;
}

/** Guard the model's state choice: no skipping into NEGOTIATE before we know their number. */
function legalNextState(pack: SkillPack, current: State, proposed: State, call: CallRecord): State {
  if (!STATES.includes(proposed)) return current;

  if (proposed === "POLICY_GATE" && !pack.states.policy_gate) return "NEGOTIATE";

  if (proposed === "NEGOTIATE") {
    const hero = call.facts[pack.ui.hero_metric];
    if (typeof hero !== "number") return "FACTS_LOOP"; // nothing to negotiate against yet
    if (call.rounds >= pack.tactics.max_rounds) return "SLOT_OR_CLOSE";
  }

  if (proposed === "SLOT_OR_CLOSE" && !pack.states.slot_booking) {
    // Skills without slot booking still need a closing beat; reuse the state as "lock the deal".
    return "SLOT_OR_CLOSE";
  }

  return proposed;
}

export type TurnResult = {
  contract: TurnContract;
  reservation: number | null;
  leverageUsed: string | null;
  latencyMs: number;
  model: string;
};

export async function runTurn(args: {
  pack: SkillPack;
  mission: Mission;
  call: CallRecord;
  bus: FactBus;
  theirLast: string;
  detectedLang: string;
  firstName: string;
  secondsLeft: number;
  /** Fires as soon as the reply sentence is decoded, before the rest of the contract. */
  onSay?: (say: string) => void;
}): Promise<TurnResult> {
  const { pack, mission, call, bus } = args;

  const { value: reservation } = resolveReservation({ pack, mission, bus, cpId: call.counterparty.id });

  // Leverage is only offered to the model during NEGOTIATE, and only if the bus has
  // a real number that clears the skill's minimum delta.
  const leverage = call.state === "NEGOTIATE" ? bus.leverageFor(call.counterparty.id) : null;

  const knownFacts: Record<string, unknown> = {};
  for (const key of Object.keys(pack.fact_schema)) {
    knownFacts[key] = call.facts[key] ?? null;
  }

  const heavy = call.state === "NEGOTIATE";

  const { value, ms, model } = await chat<TurnContract>({
    heavy,
    label: `${pack.id}/${call.state}`,
    temperature: heavy ? 0.4 : 0.6,
    // A turn contract needs ~150 tokens. The cap is what a whitespace flood runs
    // to before it stops, so every token of headroom here is dead air on the call.
    maxTokens: 220,
    json: { name: "molbhav_turn", shape: contractShape(pack, Object.keys(pack.voices)), primaryKey: "say" },
    onPrimaryValue: args.onSay,
    messages: [
      { role: "system", content: systemCore(pack, { firstName: args.firstName }) },
      {
        role: "user",
        content: turnContext({
          state: call.state,
          detectedLang: args.detectedLang,
          spec: mission.spec,
          knownFacts,
          reservation,
          leverage: leverage?.claim ?? null,
          round: call.rounds,
          maxRounds: pack.tactics.max_rounds,
          theirLast: args.theirLast,
          recentTranscript: call.transcript.map((t) => ({ role: t.role, text: t.text })),
          secondsLeft: args.secondsLeft,
        }),
      },
    ],
  });

  let contract = applyInterrupts(normaliseContract(value, pack, call));
  contract = { ...contract, next_state: legalNextState(pack, call.state, contract.next_state, call) };

  if (leverage) log.call(call.id, `leverage used: ${leverage.claim}`);

  return { contract, reservation, leverageUsed: leverage?.claim ?? null, latencyMs: ms, model };
}

/** Defensive shaping - structured outputs make this cheap insurance, not a crutch. */
function normaliseContract(raw: Partial<TurnContract>, pack: SkillPack, call: CallRecord): TurnContract {
  const facts = raw.facts_delta ?? {};
  const clean: Record<string, string | number | boolean | null> = {};
  for (const key of Object.keys(pack.fact_schema)) {
    const v = facts[key];
    clean[key] = v === undefined ? null : v;
  }
  return {
    say: (raw.say ?? "").trim(),
    lang: raw.lang || call.lang || "en-IN",
    next_state: (raw.next_state as State) ?? call.state,
    facts_delta: clean,
    signals: {
      mood: raw.signals?.mood ?? "neutral",
      asked_if_bot: Boolean(raw.signals?.asked_if_bot),
      wants_end: Boolean(raw.signals?.wants_end),
    },
    end_call: Boolean(raw.end_call),
    note: (raw.note ?? "").slice(0, 80),
  };
}

/** Opening line, spoken before the counterparty says anything. Cached by TTS. */
export function opener(pack: SkillPack, mission: Mission, lang: string): string {
  const subject = String(
    mission.spec[pack.mission_fields[0].key] ?? pack.label
  );
  const openers: Record<string, string> = {
    "hi-IN": `Namaste ji, ek chhoti si poochtaach thi - ${subject} ke baare mein. Do minute hain?`,
    "kn-IN": `Namaskara, ondu chikka vichaarane ittu - ${subject} bagge. Eradu nimisha sigutta?`,
    "ta-IN": `Vanakkam, oru chinna visayam kekanum - ${subject} pathi. Rendu nimisham irukka?`,
    "te-IN": `Namaskaram, oka chinna vishayam adagali - ${subject} gurinchi. Rendu nimishalu unnaya?`,
    "en-IN": `Hello ji, quick question about ${subject}. Do you have two minutes?`,
  };
  return openers[lang] ?? openers["en-IN"];
}
