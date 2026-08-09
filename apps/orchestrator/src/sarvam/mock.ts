import type { SkillPack } from "../skills/schema.js";
import { skills } from "../skills/registry.js";

/**
 * MOCK_SARVAM=1 replaces the Sarvam calls with a deterministic stand-in.
 *
 * This exists for two reasons that both matter today: the web app can be built and
 * demoed with no API key, and the engine's wiring - state machine, fact bus,
 * leverage gating, savings math - can be verified without spending a call or a
 * token. It is never a fallback at runtime; if the key is missing in production the
 * engine says so loudly instead of quietly faking a negotiation.
 */

export function mockEnabled(): boolean {
  return process.env.MOCK_SARVAM === "1";
}

type Ctx = {
  system: string;
  user: string;
  /** How many turns deep this conversation is. Derived, never stored - the mock is
   *  stateless so that concurrent calls cannot bleed into each other. */
  turn: number;
};

function parse(messages: { role: string; content: string }[]): Ctx {
  const userMessages = messages.filter((m) => m.role === "user");
  return {
    system: messages.find((m) => m.role === "system")?.content ?? "",
    user: userMessages.at(-1)?.content ?? "",
    turn: userMessages.length,
  };
}

function field(user: string, key: string): string {
  const m = user.match(new RegExp(`^${key}: (.*)$`, "m"));
  return m?.[1] ?? "";
}

/** Recover which pack we are simulating from the system prompt's market label. */
function packFromSystem(system: string): SkillPack | undefined {
  const m = system.match(/market\.\s*$|market"/);
  void m;
  return skills.all().find((p) => system.includes(`"${p.label}"`));
}

export function mockChat(messages: { role: string; content: string }[], schemaName?: string): unknown {
  const ctx = parse(messages);

  if (schemaName === "sim_reply") return mockSimReply(ctx);
  if (schemaName === "mission_classification") return mockClassify(ctx);
  if (schemaName === "molbhav_turn") return mockTurn(ctx);
  return "mock";
}

function mockClassify(ctx: Ctx): unknown {
  const text = ctx.user.toLowerCase();
  const pack =
    skills.all().find((p) => text.includes(p.id)) ??
    (/(phone|iphone|laptop|tv|fridge|mobile)/.test(text) ? skills.get("electronics") : undefined) ??
    (/(logo|design|brand|freelanc|designer)/.test(text) ? skills.get("freelancer") : undefined) ??
    skills.all()[0];

  const budget = Number(text.match(/(\d+)\s*k/)?.[1] ?? 0) * 1000 || Number(text.match(/\d{4,}/)?.[0] ?? 30000);
  const spec: Record<string, string | number> = {};
  for (const f of pack?.mission_fields ?? []) {
    if (f.type === "int") spec[f.key] = budget;
    else if (f.key === "area") spec[f.key] = "Koramangala";
    else if (f.key === "city") spec[f.key] = "Bengaluru";
    else if (f.required) spec[f.key] = ctx.user.slice(0, 40);
  }
  return { skill_id: pack?.id ?? "ask", confidence: 0.9, spec, pasted: { phones: [] } };
}

/** A counterparty that opens high, concedes twice, then holds. */
function mockSimReply(ctx: Ctx): unknown {
  const truth = ctx.system.match(/YOUR GROUND TRUTH[\s\S]*?\{([\s\S]*?)\n\}/)?.[1] ?? "";
  const price = Number(truth.match(/"(?:price|quote|unit_price|final_quote)":\s*(\d+)/)?.[1] ?? 32000);
  const hostile = /hostile|hangup/.test(ctx.system);

  if (hostile && ctx.turn >= 2) return { say: "Nahi chahiye, phone mat karo.", hangup: true };

  const lines = [
    `Haan boliye. Stock hai, price ${price} hai.`,
    `Cash mein ${Math.round(price * 0.97)} kar dunga, bill ke saath.`,
    `Dekhiye, ${Math.round(price * 0.94)} final. Cover free, aaj shaam tak valid.`,
    `Theek hai boss, ${Math.round(price * 0.93)} - isse neeche bilkul nahi.`,
    `Haan hold kar leta hoon aaj ke liye.`,
  ];
  return { say: lines[Math.min(ctx.turn - 1, lines.length - 1)], hangup: ctx.turn > 8 };
}

/** A negotiator that walks the state machine and extracts facts on schedule. */
function mockTurn(ctx: Ctx): unknown {
  const pack = packFromSystem(ctx.system);
  const state = field(ctx.user, "STATE");
  const lang = field(ctx.user, "DETECTED_LANG") || "hi-IN";
  const theirLast = ctx.user.match(/THEY JUST SAID: "([\s\S]*)"$/)?.[1] ?? "";
  const leverage = field(ctx.user, "LEVERAGE");
  const hasLeverage = Boolean(leverage) && !leverage.startsWith("(none");
  const round = Number(field(ctx.user, "NEGOTIATION_ROUND").split(" ")[0] ?? 0);
  const maxRounds = Number(field(ctx.user, "NEGOTIATION_ROUND").split(" ").at(-1) ?? 3);

  const quoted = Number(theirLast.replace(/,/g, "").match(/\b(\d{3,7})\b/)?.[1] ?? NaN);
  const hero = pack?.ui.hero_metric ?? "price";
  const schema = pack?.fact_schema ?? {};

  const known = parseKnownFacts(field(ctx.user, "KNOWN_FACTS"));

  const facts: Record<string, unknown> = {};
  for (const key of Object.keys(schema)) facts[key] = null;
  if (Number.isFinite(quoted)) facts[hero] = quoted;

  // Fill up to two still-unknown fields per turn, the way a real FACTS_LOOP would.
  if (state === "FACTS_LOOP" || state === "AVAILABILITY") {
    let filled = 0;
    for (const [key, f] of Object.entries(schema)) {
      if (filled >= 2) break;
      if (key === hero || known[key] !== undefined) continue;
      facts[key] =
        f.type === "bool" ? true : f.type === "int" ? 3 : f.type === "money" ? Math.round((quoted || 30000) * 0.98) : "as discussed";
      filled += 1;
    }
  }

  const stillUnknown = Object.keys(schema).filter((k) => k !== hero && known[k] === undefined).length;

  switch (state) {
    case "GREET_LANG":
    case "IDENTIFY":
      return contract("Ji, ek customer ke liye poochh raha hoon. Stock hai kya abhi?", lang, "AVAILABILITY", facts);
    case "AVAILABILITY":
      return contract("Achha. Aaj cash mein best price kya rahega?", lang, "FACTS_LOOP", facts);
    case "FACTS_LOOP":
      if (!Number.isFinite(quoted) && known[hero] === undefined) {
        return contract("Ek number bata dijiye ji, best kya kar sakte hain?", lang, "FACTS_LOOP", facts);
      }
      return contract(
        stillUnknown > 2 ? "Samajh gaya. Isme aur kya included hai?" : "Theek hai. Thoda adjust ho sakta hai?",
        lang,
        stillUnknown > 2 ? "FACTS_LOOP" : "NEGOTIATE",
        facts
      );
    case "NEGOTIATE":
      if (round < maxRounds - 1) {
        return contract(
          hasLeverage
            ? `Boss, ${leverage}. Aap match kar dijiye toh abhi confirm karta hoon.`
            : "Thoda aur dekh lijiye, abhi final kar dete hain.",
          lang,
          "NEGOTIATE",
          facts
        );
      }
      return contract("Chaliye theek hai, isi pe kar dete hain.", lang, "SLOT_OR_CLOSE", facts);
    case "SLOT_OR_CLOSE":
      return contract("Perfect ji, shaam tak hold kar dijiye. Dhanyavaad.", lang, "WRAP", facts, true);
    default:
      return contract("Dhanyavaad ji.", lang, "WRAP", facts, true);
  }
}

function parseKnownFacts(line: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const part of line.split(", ")) {
    const [k, v] = part.split("=");
    if (!k || v === undefined) continue;
    if (v === "null") continue;
    out[k.trim()] = v;
  }
  return out;
}

function contract(
  say: string,
  lang: string,
  next: string,
  facts: Record<string, unknown>,
  end = false
): unknown {
  return {
    say,
    lang,
    next_state: next,
    facts_delta: facts,
    signals: { mood: "neutral", asked_if_bot: false, wants_end: false },
    end_call: end,
    note: "mock turn",
  };
}

/** 200ms of silence, so the Twilio path can be exercised without synthesising audio. */
export function mockAudio(): Buffer {
  return Buffer.alloc(1600, 0xff);
}
