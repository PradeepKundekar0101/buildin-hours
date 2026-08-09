import { randomUUID } from "node:crypto";
import type { SkillPack } from "../skills/schema.js";
import type { FactBus } from "./fact-bus.js";
import { runTurn, opener } from "./negotiator.js";
import { fillerFor, closerFor } from "../sarvam/tts.js";
import type { Transport, TransportEndReason } from "./transport.js";
import type { CallOutcome, CallRecord, Counterparty, Mission, State } from "./types.js";
import { log } from "../log.js";

/** How long to let a caller keep talking before we compose a reply. Sarvam's VAD
 *  already waits 700ms of silence before finalising, so this only needs to catch
 *  the burst that finalises in two pieces - not re-buy the whole silence window. */
const SETTLE_MS = 250;

/** How long a caller will tolerate silence before the line feels dead. */
const FILLER_AFTER_MS = 700;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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
    this.capTimer = setTimeout(
      () => void this.wrapUp("capped", { goodbye: true }),
      this.pack.policies.call_cap_s * 1000
    );

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

    this.pending.push({ text, lang });
    if (this.busyWithTurn) return;

    // People speak in bursts, and Sarvam finalises each one. Answering the first
    // fragment means talking over the rest of their sentence, so wait a beat and
    // fold anything that lands in that window into the same turn.
    await sleep(SETTLE_MS);
    void this.drain();
  }

  /** Take everything the caller has said and answer it as one turn, in order. */
  private async drain(): Promise<void> {
    if (this.ended || this.busyWithTurn) return;

    const merged = this.pending.splice(0);
    if (!merged.length) return;

    this.busyWithTurn = true;
    try {
      const theirLast = merged.map((q) => q.text).join(" ");
      const detectedLang = merged.at(-1)?.lang ?? this.call.lang;

      if (detectedLang && detectedLang !== this.call.lang) {
        log.call(this.call.id, `language switch ${this.call.lang} -> ${detectedLang}`);
        this.call.lang = detectedLang;
      }

      this.pushTurn("them", theirLast, detectedLang);

      // Filler state lives out here because the early-speech callback below must be
      // able to cancel it the moment real words are ready.
      let fillerPlaying: Promise<void> | null = null;
      let fillerTimer: NodeJS.Timeout | null = null;

      // The reply sentence decodes seconds before the rest of the turn contract on
      // a live line, so speech starts from the stream, not from the parsed result.
      // PSTN only: the simulator is a text peer, and early speech there would fork
      // the transcript from what the contract actually said.
      let earlySay: string | null = null;
      let earlySpeech: Promise<void> | null = null;

      const thinking = runTurn({
        pack: this.pack,
        mission: this.mission,
        call: this.call,
        bus: this.bus,
        theirLast,
        detectedLang,
        firstName: this.firstName,
        secondsLeft: this.secondsLeft,
        onSay:
          this.transport.kind === "pstn"
            ? (say) => {
                if (this.ended || earlySpeech) return;
                earlySay = say;
                if (fillerTimer) {
                  clearTimeout(fillerTimer);
                  fillerTimer = null;
                }
                earlySpeech = (async () => {
                  // Never talk over ourselves: let a filler already playing finish.
                  if (fillerPlaying) await fillerPlaying;
                  await this.transport.speak(say, detectedLang);
                })().catch(() => undefined);
              }
            : undefined,
      });

      // Silence on a phone call reads as a dropped line, and people hang up. If the
      // model is still composing after a beat, say what a person would say - the
      // filler is pre-synthesised, so it costs nothing but the playback itself.
      // Only on a real line. The simulator has no audio, and feeding it a filler
      // would put "ek second ji" into the transcript as a negotiating move.
      fillerTimer =
        this.transport.kind === "pstn"
          ? setTimeout(() => {
              fillerTimer = null;
              fillerPlaying = this.transport
                .speak(fillerFor(detectedLang), detectedLang)
                .catch(() => undefined);
            }, FILLER_AFTER_MS)
          : null;

      let result: Awaited<typeof thinking>;
      try {
        result = await thinking;
      } catch (err) {
        // The sentence may already be on the wire even though the contract never
        // parsed. That is a fine turn on its own - record it and stay in state.
        if (earlySpeech) {
          log.call(this.call.id, `contract unusable after early speech: ${err instanceof Error ? err.message : err}`);
          this.pushTurn("us", earlySay ?? "", detectedLang);
          await earlySpeech;
          return;
        }
        throw err;
      } finally {
        if (fillerTimer) clearTimeout(fillerTimer);
        // Never talk over ourselves: let the filler finish before the real reply.
        if (fillerPlaying && !earlySpeech) await fillerPlaying;
      }

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

      if (earlySpeech) {
        // Speech began mid-stream; the transcript records what actually went on air.
        this.pushTurn("us", earlySay ?? contract.say, contract.lang, result.latencyMs);
        await earlySpeech;
      } else if (contract.say) {
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

      if (this.secondsLeft <= 25 && this.call.state !== "WRAP") {
        log.call(this.call.id, "time cap approaching, wrapping");
        await this.wrapUp(this.outcomeFromFacts(), { goodbye: true });
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
      // Anything said while we were thinking is still queued, in order.
      if (this.pending.length) void this.drain();
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

  private async wrapUp(outcome: CallOutcome, opts?: { goodbye?: boolean }): Promise<void> {
    if (this.ended) return;

    // When the clock ends the call rather than the conversation, going silent
    // mid-question reads as a dropped line and burns the lead. Say a proper
    // close first - it is pre-synthesised, so it costs only its own playback.
    // The model-initiated paths (wants_end, WRAP) already spoke their goodbye.
    if (opts?.goodbye && this.transport.kind === "pstn") {
      const line = closerFor(this.call.lang);
      this.pushTurn("us", line, this.call.lang);
      try {
        await this.transport.speak(line, this.call.lang);
      } catch {
        /* line already gone */
      }
    }

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
