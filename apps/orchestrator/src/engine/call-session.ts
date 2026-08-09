import { randomUUID } from "node:crypto";
import type { SkillPack } from "../skills/schema.js";
import type { FactBus } from "./fact-bus.js";
import { runTurn, opener } from "./negotiator.js";
import type { Transport, TransportEndReason } from "./transport.js";
import type { CallOutcome, CallRecord, Counterparty, Mission, State } from "./types.js";
import { log } from "../log.js";

/**
 * One counterparty, one conversation. Owns the state machine, the clock, and the
 * decision to hang up. Knows nothing about telephony.
 */

export type SessionEvents = {
  onTurn: (call: CallRecord, turn: { role: "us" | "them"; text: string; lang?: string; latency_ms?: number }) => void;
  onFacts: (call: CallRecord, delta: Record<string, unknown>) => void;
  onState: (call: CallRecord, state: State) => void;
  onEnd: (call: CallRecord) => void;
};

export class CallSession {
  readonly call: CallRecord;
  private busyWithTurn = false;
  private ended = false;
  private capTimer: NodeJS.Timeout | null = null;
  private startedAt = Date.now();
  /** Utterances that arrived while a turn was in flight. */
  private pending: { text: string; lang?: string }[] = [];

  constructor(
    private pack: SkillPack,
    private mission: Mission,
    counterparty: Counterparty,
    private bus: FactBus,
    private transport: Transport,
    private events: SessionEvents,
    private firstName: string
  ) {
    this.call = {
      id: randomUUID(),
      mission_id: mission.id,
      counterparty,
      state: "DIAL",
      facts: {},
      first_quote: null,
      final_quote: null,
      rounds: 0,
      transcript: [],
      outcome: null,
      started_at: Date.now(),
      ended_at: null,
      lang: counterparty.lang_hint ?? "en-IN",
    };
  }

  get secondsLeft(): number {
    return this.pack.policies.call_cap_s - (Date.now() - this.startedAt) / 1000;
  }

  async run(): Promise<CallRecord> {
    const dup = this.bus.register(this.call.counterparty);
    if (dup.duplicateOf) {
      log.call(this.call.id, `skipped - duplicate of ${dup.duplicateOf} via ${dup.key}`);
      return this.finish("duplicate");
    }

    this.transport.onUtterance((text, lang) => void this.handleUtterance(text, lang));
    this.transport.onBargeIn(() => log.call(this.call.id, "barge-in"));
    this.transport.onEnded((reason) => void this.handleTransportEnd(reason));

    try {
      await this.transport.start();
    } catch (err) {
      log.call(this.call.id, `dial failed: ${err instanceof Error ? err.message : err}`);
      return this.finish("no_answer");
    }

    this.startedAt = Date.now();
    this.capTimer = setTimeout(() => void this.wrapUp("capped"), this.pack.policies.call_cap_s * 1000);

    this.setState("GREET_LANG");
    const line = opener(this.pack, this.mission, this.call.lang);
    this.pushTurn("us", line, this.call.lang);
    // Advance before speaking, not after: the far end routinely talks over or
    // straight after the greeting, and that reply must be handled as IDENTIFY.
    this.setState("IDENTIFY");
    await this.transport.speak(line, this.call.lang);

    // The rest of the call is driven by utterances arriving from the transport.
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (this.ended) {
          clearInterval(check);
          resolve();
        }
      }, 120);
    });

    return this.call;
  }

  private async handleUtterance(text: string, lang?: string): Promise<void> {
    if (this.ended) return;
    if (!text.trim()) return;

    if (this.busyWithTurn) {
      this.pending.push({ text, lang });
      return;
    }

    this.busyWithTurn = true;
    try {
      // Fold anything that queued up while we were thinking into one context.
      const queued = this.pending.splice(0);
      const theirLast = [text, ...queued.map((q) => q.text)].join(" ");
      const detectedLang = lang ?? queued.at(-1)?.lang ?? this.call.lang;

      if (detectedLang && detectedLang !== this.call.lang) {
        log.call(this.call.id, `language switch ${this.call.lang} -> ${detectedLang}`);
        this.call.lang = detectedLang;
      }

      this.pushTurn("them", theirLast, detectedLang);

      const result = await runTurn({
        pack: this.pack,
        mission: this.mission,
        call: this.call,
        bus: this.bus,
        theirLast,
        detectedLang,
        firstName: this.firstName,
        secondsLeft: this.secondsLeft,
      });

      const { contract } = result;

      // Facts first: publishing before we speak means a sibling call can use this
      // number in its very next turn.
      const delta = Object.fromEntries(
        Object.entries(contract.facts_delta).filter(([, v]) => v !== null)
      );
      if (Object.keys(delta).length) {
        Object.assign(this.call.facts, delta);
        this.bus.publish(this.call.counterparty.id, contract.facts_delta);
        this.events.onFacts(this.call, delta);

        const hero = this.call.facts[this.pack.ui.hero_metric];
        if (typeof hero === "number") {
          if (this.call.first_quote === null) this.call.first_quote = hero;
          this.call.final_quote = hero;
        }
      }

      if (this.call.state === "NEGOTIATE" && contract.next_state === "NEGOTIATE") {
        this.call.rounds += 1;
      }

      if (contract.say) {
        this.pushTurn("us", contract.say, contract.lang, result.latencyMs);
        await this.transport.speak(contract.say, contract.lang);
      }

      if (contract.signals.wants_end) {
        await this.wrapUp("opted_out");
        return;
      }
      if (contract.end_call || contract.next_state === "DONE" || contract.next_state === "WRAP") {
        this.setState("WRAP");
        await this.wrapUp(this.outcomeFromFacts());
        return;
      }

      this.setState(contract.next_state);

      if (this.secondsLeft <= 12 && this.call.state !== "WRAP") {
        log.call(this.call.id, "time cap approaching, wrapping");
        await this.wrapUp(this.outcomeFromFacts());
      }
    } catch (err) {
      log.call(this.call.id, `turn failed: ${err instanceof Error ? err.message : err}`);
      // One bad turn should not kill a live call; ask them to repeat and carry on.
      try {
        await this.transport.speak("Sorry ji, ek baar phir se boliye?", this.call.lang);
      } catch {
        /* line already gone */
      }
    } finally {
      this.busyWithTurn = false;
      const next = this.pending.shift();
      if (next) void this.handleUtterance(next.text, next.lang);
    }
  }

  /** No usable facts at all means the lead is a ghost - stamp it so nobody redials. */
  private outcomeFromFacts(): CallOutcome {
    const hero = this.call.facts[this.pack.ui.hero_metric];
    if (typeof hero === "number") return "closed";
    if (Object.keys(this.call.facts).length === 0) return "dead_lead";
    return "declined";
  }

  private async handleTransportEnd(reason: TransportEndReason): Promise<void> {
    if (this.ended) return;
    const map: Record<TransportEndReason, CallOutcome> = {
      completed: this.outcomeFromFacts(),
      no_answer: "no_answer",
      busy: "no_answer",
      voicemail: "voicemail",
      failed: "error",
      hangup: this.outcomeFromFacts(),
      cap: "capped",
    };
    this.finish(map[reason]);
  }

  private async wrapUp(outcome: CallOutcome): Promise<void> {
    if (this.ended) return;
    try {
      await this.transport.hangup(outcome);
    } catch {
      /* already down */
    }
    this.finish(outcome);
  }

  private finish(outcome: CallOutcome): CallRecord {
    if (this.ended) return this.call;
    this.ended = true;
    if (this.capTimer) clearTimeout(this.capTimer);
    this.call.outcome = outcome;
    this.call.ended_at = Date.now();
    this.call.state = "DONE";
    this.call.recording_url = this.transport.recordingUrl;

    if (outcome === "dead_lead" || outcome === "no_answer" || outcome === "voicemail") {
      this.bus.markDead(this.call.counterparty.id);
    }

    log.call(
      this.call.id,
      `ended ${outcome} · ${this.call.rounds} rounds · ${this.pack.ui.hero_metric}=${this.call.final_quote ?? "-"} · ${Math.round(
        (this.call.ended_at - this.call.started_at) / 1000
      )}s`
    );
    this.events.onEnd(this.call);
    return this.call;
  }

  private setState(state: State): void {
    if (this.call.state === state) return;
    this.call.state = state;
    this.events.onState(this.call, state);
  }

  private pushTurn(role: "us" | "them", text: string, lang?: string, latency_ms?: number): void {
    const turn = { at: Date.now(), role, text, lang, state: this.call.state, latency_ms };
    this.call.transcript.push(turn);
    this.events.onTurn(this.call, { role, text, lang, latency_ms });
  }
}
