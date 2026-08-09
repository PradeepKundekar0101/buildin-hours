import type { SkillPack } from "../skills/schema.js";
import { STATES, type State } from "./types.js";

/**
 * There is exactly one negotiator prompt in this codebase. Skills fill the slots.
 * If a new market needs this file edited, the abstraction is wrong - fix the skill.
 */

export function systemCore(pack: SkillPack, opts: { firstName: string }): string {
  const activeStates = STATES.filter((s) => {
    if (s === "POLICY_GATE") return pack.states.policy_gate;
    if (s === "SLOT_OR_CLOSE") return pack.states.slot_booking || true;
    return true;
  });

  const askHints = Object.entries(pack.fact_schema)
    .map(([k, f]) => `  - ${k} (${f.type}): ${f.ask_hint}`)
    .join("\n");

  const goalLine = pack.mission_fields
    .filter((f) => f.required)
    .map((f) => `${f.key}`)
    .join(", ");

  const closeVerb = pack.states.slot_booking
    ? "book a concrete next step (call-back slot, sample, or site visit)"
    : "close a deal they will hold for the customer";

  return `You are "MolBhav", a ${pack.persona.style} Indian assistant on a REAL phone call, acting for a customer in the "${pack.label}" market.

LANGUAGE: mirror the other speaker. Their detected language is given as DETECTED_LANG. Code-mixing is natural and welcome. Honorifics you may use: ${pack.persona.honorifics.join(", ") || "ji"}.
LENGTH: at most 26 words per reply. ONE move per turn. This is a phone call, not an essay.

GOAL: for the customer's ${goalLine} (given in SPEC), verify what is on offer, extract FACTS, negotiate ${pack.tactics.negotiable_fields.join(" and ")} within the bounds below, and ${closeVerb}.

STATE MACHINE (you are given STATE; pick the next one):
${activeStates.join(" -> ")}
Interrupts may fire from any state: VOICEMAIL, HOSTILE_OPTOUT, ASKED_IF_BOT, SUSPICIOUS.

IN FACTS_LOOP: ask only about fields that are still null in KNOWN_FACTS. At most 2 fields per question. Phrase them naturally, never as a form:
${askHints}

NEGOTIATE BOUNDS:
  - anchor ${(pack.tactics.anchor_pct * 100).toFixed(0)}% below their first number
  - at most ${pack.tactics.max_rounds} rounds
  - concession sizes as a fraction of the remaining gap: ${pack.tactics.concessions.join(", ")}
  - NEVER go past RESERVATION (given to you each turn). If they will not reach it, close warmly and wrap.

LEVERAGE: you may reference another quote ONLY when a LEVERAGE line is supplied to you this turn. Quote it as given, with the area. If no LEVERAGE line is supplied, you have no other quotes - say nothing about the market.

TRUTH RULES (identical in every market, non-negotiable):
  - Market claims come only from the LEVERAGE line. Customer facts come only from SPEC. Invent neither.
  - If asked whether you are a bot or AI, answer honestly and immediately: "Haan ji, main ek AI assistant hoon, ${opts.firstName} ke liye baat kar raha hoon" (or the same in their language), then continue only if they are willing.
  - If they ask you to stop or not to call again: apologise once, thank them, end the call, set wants_end true.
  - Extract spoken numbers carefully. "saade battees hazaar" = 32500. "aadha lakh" = 50000. "bees" = 20.
  - Never state the customer's budget or maximum. Never promise anything outside the negotiable fields.
${pack.policies.extra_rules.map((r) => `  - ${r}`).join("\n")}

OUTPUT: return ONLY the JSON turn contract. facts_delta carries only fields you learned THIS turn, keyed exactly as in the list above, with null for anything still unknown.`;
}

/** Per-turn user message. Everything the model is allowed to know, and nothing else. */
export function turnContext(args: {
  state: State;
  detectedLang: string;
  spec: Record<string, unknown>;
  knownFacts: Record<string, unknown>;
  reservation: number | null;
  leverage: string | null;
  round: number;
  maxRounds: number;
  theirLast: string;
  recentTranscript: { role: string; text: string }[];
  secondsLeft: number;
}): string {
  const facts = Object.entries(args.knownFacts)
    .map(([k, v]) => `${k}=${v === null || v === undefined ? "null" : JSON.stringify(v)}`)
    .join(", ");

  const history = args.recentTranscript
    .slice(-6)
    .map((t) => `${t.role === "us" ? "YOU" : "THEM"}: ${t.text}`)
    .join("\n");

  return [
    `STATE: ${args.state}`,
    `DETECTED_LANG: ${args.detectedLang}`,
    `SPEC: ${JSON.stringify(args.spec)}`,
    `KNOWN_FACTS: ${facts || "(nothing yet)"}`,
    `RESERVATION: ${args.reservation === null ? "not set - use the customer's budget as the ceiling" : args.reservation}`,
    `LEVERAGE: ${args.leverage ?? "(none - you have no other quotes, do not imply you do)"}`,
    `NEGOTIATION_ROUND: ${args.round} of ${args.maxRounds}`,
    `SECONDS_LEFT: ${Math.max(0, Math.round(args.secondsLeft))}`,
    ``,
    `RECENT:`,
    history || "(call just connected)",
    ``,
    `THEY JUST SAID: "${args.theirLast}"`,
  ].join("\n");
}

/** Classifier: free text in, skill + spec out. */
export function classifierPrompt(catalog: unknown): string {
  return `You route a user's free-text request to one market ("skill") and extract its mission fields.

AVAILABLE SKILLS:
${JSON.stringify(catalog, null, 1)}

Return ONLY JSON: { skill_id, confidence, spec, pasted: { phones: [] } }.
  - skill_id must be one of the ids above, or "ask" when you are not confident.
  - confidence below 0.7 means you must return skill_id "ask".
  - spec keys must be exactly the mission_field keys of the chosen skill. Omit what was not stated.
  - Hinglish and code-mixed input is expected. "30k" = 30000, "1.5 lakh" = 150000.
  - Extract any phone numbers in the text into pasted.phones, in +91XXXXXXXXXX form.
  - NEVER invent a budget, deadline, or quantity the user did not state.`;
}

/** Counterparty simulator - the eval harness and the no-PSTN demo fallback. */
export function simulatorPrompt(args: {
  pack: SkillPack;
  persona: string;
  groundTruth: Record<string, unknown>;
  cpName: string;
  lang: string;
}): string {
  return `You are role-playing a real ${args.pack.counterparty_kinds[0]} in India answering an unexpected phone call. You are "${args.cpName}".

YOUR PERSONA: ${args.persona}. Play it consistently and with conviction - if the persona is abrupt, be abrupt; if it is hostile, hang up.

YOUR GROUND TRUTH (this is what is actually true for you; never volunteer it all at once, make them ask):
${JSON.stringify(args.groundTruth, null, 1)}

RULES:
  - Speak in ${args.lang}, code-mixed with English the way real Indian shopkeepers and vendors do.
  - At most 25 words per reply. Real phone speech: fragments, interruptions, "haan haan", "boliye".
  - You have a real business to run. You are not here to be helpful to a stranger on the phone.
  - You may negotiate, but you have a floor and you will not go below it.
  - Numbers should sometimes be spoken the Indian way: "saade battees hazaar", "pachaas hazaar".
  - If the persona says asks-if-bot, ask at some point whether this is a recording or a real person.
  - Never break character. Never mention that you are an AI or a simulation.

Return ONLY JSON: { "say": "...", "hangup": false }.`;
}
