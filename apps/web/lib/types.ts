export type MissionField = {
  key: string;
  label: string;
  type: "text" | "int" | "date" | "enum" | "chips";
  required: boolean;
  options?: string[];
  placeholder?: string;
  default?: string | number;
};

export type Column = { key: string; label: string; type: string };

export type Skill = {
  id: string;
  label: string;
  emoji: string;
  ui: { mode: "ticker" | "table"; hero_metric: string };
  mission_fields: MissionField[];
  paste_hint: string;
  share_copy: string;
  columns: Column[];
  hero_metric: string;
  counterparty_kinds: string[];
};

export type Counterparty = {
  id: string;
  name: string;
  phone: string;
  kind: string;
  area?: string;
  city?: string;
  source: string;
  lang_hint?: string;
};

export type MissionEvent = {
  type: string;
  at: number;
  [k: string]: unknown;
};

export type Utterance = {
  at: number;
  role: "us" | "them";
  text: string;
  lang?: string;
  latency_ms?: number;
};

/** One open line, assembled on the client from the event stream. */
export type Line = {
  cp: Counterparty;
  state: string;
  facts: Record<string, unknown>;
  value: number | null;
  first: number | null;
  /** The whole conversation, in order. This is the thing people actually watch. */
  turns: Utterance[];
  lastText: string;
  lastRole: "us" | "them";
  lang?: string;
  dead: boolean;
  ended: boolean;
  outcome?: string;
  recording?: string;
  freshFields: Set<string>;
};
