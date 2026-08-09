import type { SkillPack } from "../skills/schema.js";

/** The universal state machine. Every market walks the same graph; skills switch states on and off. */
export const STATES = [
  "DIAL",
  "GREET_LANG",
  "IDENTIFY",
  "AVAILABILITY",
  "FACTS_LOOP",
  "POLICY_GATE",
  "NEGOTIATE",
  "SLOT_OR_CLOSE",
  "WRAP",
  "DONE",
] as const;
export type State = (typeof STATES)[number];

/** Interrupts can fire from any state. */
export const INTERRUPTS = ["VOICEMAIL", "HOSTILE_OPTOUT", "ASKED_IF_BOT", "SUSPICIOUS"] as const;
export type Interrupt = (typeof INTERRUPTS)[number];

export type FactValue = string | number | boolean | null;
export type Facts = Record<string, FactValue>;

export type Counterparty = {
  id: string;
  name: string;
  phone: string;
  kind: string;
  area?: string;
  city?: string;
  source: "pasted" | "places" | "seed";
  /** Free-form attributes used by dedup keys (store_chain_name, person_name, ...). */
  attrs: Record<string, string>;
  lang_hint?: string;
};

export type MissionSpec = Record<string, string | number>;

export type Mission = {
  id: string;
  skill_id: string;
  user_id: string;
  user_phone?: string;
  spec: MissionSpec;
  created_at: number;
  status: "running" | "done" | "cancelled";
};

export type CallOutcome =
  | "closed"
  | "no_answer"
  | "voicemail"
  | "declined"
  | "opted_out"
  | "dead_lead"
  | "duplicate"
  | "error"
  | "capped";

export type CallRecord = {
  id: string;
  mission_id: string;
  counterparty: Counterparty;
  state: State;
  facts: Facts;
  /** Their opening number on the hero metric, before any negotiation. */
  first_quote: number | null;
  /** Where they landed. */
  final_quote: number | null;
  rounds: number;
  transcript: Turn[];
  outcome: CallOutcome | null;
  started_at: number;
  ended_at: number | null;
  recording_url?: string;
  note?: string;
  lang: string;
};

export type Turn = {
  at: number;
  role: "them" | "us";
  text: string;
  lang?: string;
  state?: State;
  latency_ms?: number;
};

/** The one JSON contract every skill returns, every turn. */
export type TurnContract = {
  say: string;
  lang: string;
  next_state: State;
  facts_delta: Facts;
  signals: {
    mood: "warm" | "neutral" | "busy" | "hostile";
    asked_if_bot: boolean;
    wants_end: boolean;
  };
  end_call: boolean;
  note: string;
};

export type EngineContext = {
  pack: SkillPack;
  mission: Mission;
  call: CallRecord;
};
