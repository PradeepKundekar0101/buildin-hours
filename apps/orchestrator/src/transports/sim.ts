import { chat } from "../sarvam/chat.js";
import { simulatorPrompt } from "../engine/prompts.js";
import type { Transport, TransportEndReason } from "../engine/transport.js";
import type { SkillPack } from "../skills/schema.js";
import type { Counterparty } from "../engine/types.js";
import { log } from "../log.js";

/**
 * A counterparty played by Sarvam, over text.
 *
 * This is not a toy. It is the eval harness, the rehearsal partner, and the demo
 * fallback when venue telephony fails - and because it implements Transport, it
 * drives the identical negotiation core that a real PSTN call does.
 */

export type SimOptions = {
  pack: SkillPack;
  counterparty: Counterparty;
  callId: string;
  persona: string;
  /** What is actually true for this simulated business. */
  groundTruth: Record<string, unknown>;
  lang: string;
  /** Simulated thinking time, so latency numbers stay honest-ish. */
  replyDelayMs?: number;
  maxTurns?: number;
};

export class SimTransport implements Transport {
  readonly kind = "sim" as const;
  readonly id: string;
  recordingUrl: string | undefined;

  private utteranceCb: ((text: string, lang?: string) => void) | null = null;
  private endedCb: ((reason: TransportEndReason) => void) | null = null;
  private history: { role: "system" | "user" | "assistant"; content: string }[] = [];
  private turns = 0;
  private dead = false;
  private consecutiveFailures = 0;

  constructor(private opts: SimOptions) {
    this.id = opts.callId;
    this.history.push({
      role: "system",
      content: simulatorPrompt({
        pack: opts.pack,
        persona: opts.persona,
        groundTruth: opts.groundTruth,
        cpName: opts.counterparty.name,
        lang: opts.lang,
      }),
    });
  }

  async start(): Promise<void> {
    // A busy shopkeeper picks up mid-sentence.
    return;
  }

  onUtterance(cb: (text: string, lang?: string) => void): void {
    this.utteranceCb = cb;
  }

  onBargeIn(): void {
    // Text simulation has no overlapping speech.
  }

  onEnded(cb: (reason: TransportEndReason) => void): void {
    this.endedCb = cb;
  }

  /**
   * We "say" something; the persona replies. The reply is delivered asynchronously,
   * exactly as a real utterance would arrive from the STT socket.
   */
  async speak(text: string): Promise<void> {
    if (this.dead) return;
    this.history.push({ role: "user", content: text });
    this.turns += 1;

    if (this.turns > (this.opts.maxTurns ?? 24)) {
      this.end("cap");
      return;
    }

    try {
      const { value } = await chat<{ say: string; hangup: boolean }>({
        messages: this.history,
        temperature: 0.9,
        maxTokens: 160,
        label: `sim/${this.opts.persona}`,
        json: {
          name: "sim_reply",
          shape: '{\n  "say": "string, at most 25 words, in character",\n  "hangup": true|false\n}',
          primaryKey: "say",
        },
      });

      this.history.push({ role: "assistant", content: JSON.stringify(value) });

      if (this.opts.replyDelayMs) await sleep(this.opts.replyDelayMs);
      if (this.dead) return;

      if (value.say?.trim()) {
        this.utteranceCb?.(value.say.trim(), this.opts.lang);
      }
      if (value.hangup) {
        setTimeout(() => this.end("hangup"), 50);
      }
    } catch (err) {
      // One bad generation is not a hangup. Stay in character, keep the line open,
      // and only give up if the counterparty goes silent twice running.
      this.consecutiveFailures += 1;
      log.call(
        this.id,
        `sim reply failed (${this.consecutiveFailures}): ${err instanceof Error ? err.message : err}`
      );
      if (this.consecutiveFailures >= 2) {
        this.end("failed");
        return;
      }
      this.utteranceCb?.("Haan ji, boliye.", this.opts.lang);
      return;
    }
    this.consecutiveFailures = 0;
  }

  async hangup(): Promise<void> {
    this.end("hangup");
  }

  private end(reason: TransportEndReason): void {
    if (this.dead) return;
    this.dead = true;
    this.endedCb?.(reason);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Ground truth for a simulated counterparty, derived from the skill's own fact
 * schema. No per-skill code: a new market gets a working simulator for free.
 */
export function syntheticGroundTruth(pack: SkillPack, spec: Record<string, unknown>, seed: number): Record<string, unknown> {
  const rnd = mulberry(seed);
  const truth: Record<string, unknown> = {};

  const budget = Number(
    Object.entries(spec).find(([k]) => /budget|target/.test(k))?.[1] ?? 30000
  );

  for (const [key, field] of Object.entries(pack.fact_schema)) {
    switch (field.type) {
      case "money": {
        // Real quotes cluster around the budget: some below, most a bit above.
        const factor = 0.92 + rnd() * 0.35;
        truth[key] = Math.round((budget * factor) / 100) * 100;
        break;
      }
      case "int":
        truth[key] = 1 + Math.floor(rnd() * 12);
        break;
      case "bool":
        truth[key] = rnd() > 0.25;
        break;
      case "date":
        truth[key] = "within two weeks";
        break;
      default:
        truth[key] = pickString(key, rnd);
    }
  }
  truth["_floor_note"] = "You will not go below about 92% of your opening number.";
  return truth;
}

function pickString(key: string, rnd: () => number): string {
  const pools: Record<string, string[]> = {
    conditions: ["cash or UPI only, no card", "card is fine but 2% extra", "exchange needed for this price"],
    validity: ["only today till 8pm", "till tomorrow evening", "this price is for right now"],
    freebies: ["cover free", "cover and screen guard", "nothing extra at this price"],
    payment_terms: ["50% advance, rest on delivery", "30 days credit for regular buyers", "full advance"],
    sample_policy: ["sample charged, adjusted in order", "free sample if you pay courier", "no samples"],
    insurance: ["transit insurance at 2% extra", "no insurance", "basic damage cover included"],
    hidden_charges: ["GST extra, lift charge if no lift", "all inclusive", "toll and parking extra"],
  };
  const pool = pools[key] ?? ["yes, that is possible", "we can manage that", "that is not our practice"];
  return pool[Math.floor(rnd() * pool.length)];
}

/** Deterministic PRNG so an eval run is reproducible across seeds. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
