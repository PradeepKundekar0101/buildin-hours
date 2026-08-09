import type { SkillPack } from "../skills/schema.js";
import type { Counterparty } from "./types.js";

/**
 * The seam that lets the negotiation core stay honest.
 *
 * A PSTN call and a simulated counterparty implement the same three verbs, so the
 * eval harness exercises the exact code that runs on stage. When the venue's
 * telephony inevitably wobbles, the demo falls back to SimTransport without the
 * engine noticing.
 */
export interface Transport {
  readonly id: string;
  readonly kind: "pstn" | "sim";

  /** Dial / connect. Resolves once the far end is actually listening. */
  start(): Promise<void>;

  /** Say something. Resolves when playback finishes or is cut short by barge-in. */
  speak(text: string, lang: string): Promise<void>;

  /** A completed utterance from the far end, with Sarvam's detected language. */
  onUtterance(cb: (text: string, lang?: string) => void): void;

  /** They started talking over us. */
  onBargeIn(cb: () => void): void;

  /** The line is gone. */
  onEnded(cb: (reason: TransportEndReason) => void): void;

  hangup(reason?: string): Promise<void>;

  /** Where the audio landed, if the transport records. */
  recordingUrl?: string;
}

export type TransportEndReason = "completed" | "no_answer" | "busy" | "voicemail" | "failed" | "hangup" | "cap";

export type TransportDeps = {
  pack: SkillPack;
  counterparty: Counterparty;
  callId: string;
  /** Language to open in, from the counterparty's hint or the area default. */
  openingLang: string;
};
