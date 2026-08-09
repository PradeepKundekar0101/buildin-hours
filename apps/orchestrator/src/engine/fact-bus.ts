import { EventEmitter } from "node:events";
import type { SkillPack } from "../skills/schema.js";
import type { Counterparty, Facts, FactValue } from "./types.js";

/**
 * The Fact Bus.
 *
 * Everything a call learns is published here the moment it is learned, so the other
 * live calls can use it in the same minute. That is the whole difference between
 * "six calls at once" and "six calls that share intelligence": a real quote from
 * Store B becomes real leverage at Store A while both lines are still open.
 *
 * Hard rule enforced here and echoed in the prompt: leverage lines may only ever
 * quote numbers that actually arrived on this bus. No invented market claims.
 */

export type BusEntry = {
  cp: Counterparty;
  facts: Facts;
  /** Their opening number on the hero metric. */
  first: number | null;
  /** Their latest number on the hero metric. */
  latest: number | null;
  dead: boolean;
  updated_at: number;
};

export type LeverageLine = {
  /** Verbatim claim the negotiator is allowed to make. */
  claim: string;
  value: number;
  from_area: string;
  from_cp_id: string;
};

export type BusEvent =
  | { type: "facts"; cp_id: string; facts_delta: Facts }
  | { type: "dedup"; cp_id: string; duplicate_of: string; key: string }
  | { type: "dead_lead"; cp_id: string }
  | { type: "best"; cp_id: string; field: string; value: number };

export class FactBus extends EventEmitter {
  private entries = new Map<string, BusEntry>();
  /** dedup key -> first counterparty id that claimed it */
  private dedupIndex = new Map<string, string>();

  constructor(private pack: SkillPack, public readonly missionId: string) {
    super();
  }

  private get heroField(): string {
    return this.pack.ui.hero_metric;
  }

  register(cp: Counterparty): { duplicateOf?: string; key?: string } {
    if (!this.entries.has(cp.id)) {
      this.entries.set(cp.id, { cp, facts: {}, first: null, latest: null, dead: false, updated_at: Date.now() });
    }

    if (!this.pack.capabilities.dedup.keys.length) return {};

    for (const keyName of this.pack.capabilities.dedup.keys) {
      const rawValue = cp.attrs[keyName] ?? "";
      if (!rawValue.trim()) continue;
      const key = `${keyName}:${normalise(rawValue)}`;
      const owner = this.dedupIndex.get(key);
      if (owner && owner !== cp.id) {
        this.emit("event", { type: "dedup", cp_id: cp.id, duplicate_of: owner, key } satisfies BusEvent);
        return { duplicateOf: owner, key };
      }
      this.dedupIndex.set(key, cp.id);
    }
    return {};
  }

  publish(cpId: string, delta: Facts): void {
    const entry = this.entries.get(cpId);
    if (!entry) return;

    let changed = false;
    for (const [k, v] of Object.entries(delta)) {
      if (v === null || v === undefined) continue;
      if (!(k in this.pack.fact_schema)) continue; // schema is the contract; ignore stray keys
      const coerced = coerce(v, this.pack.fact_schema[k].type);
      if (coerced === null) continue;
      if (entry.facts[k] !== coerced) {
        entry.facts[k] = coerced;
        changed = true;
      }
    }
    if (!changed) return;

    entry.updated_at = Date.now();

    const hero = entry.facts[this.heroField];
    if (typeof hero === "number") {
      if (entry.first === null) entry.first = hero;
      entry.latest = hero;
      this.emit("event", { type: "best", cp_id: cpId, field: this.heroField, value: hero } satisfies BusEvent);
    }

    this.emit("event", { type: "facts", cp_id: cpId, facts_delta: delta } satisfies BusEvent);
  }

  markDead(cpId: string): void {
    if (!this.pack.capabilities.dead_lead) return;
    const entry = this.entries.get(cpId);
    if (!entry || entry.dead) return;
    entry.dead = true;
    this.emit("event", { type: "dead_lead", cp_id: cpId } satisfies BusEvent);
  }

  /**
   * Best number anyone else has given us on the hero metric.
   * "Best" means lowest for a price we are paying - which is every skill we ship.
   */
  bestExternal(excludeCpId: string): { value: number; cp: Counterparty } | null {
    let best: { value: number; cp: Counterparty } | null = null;
    for (const [id, e] of this.entries) {
      if (id === excludeCpId || e.dead || e.latest === null) continue;
      if (!best || e.latest < best.value) best = { value: e.latest, cp: e.cp };
    }
    return best;
  }

  /**
   * Build the one leverage sentence this call is permitted to say, or null.
   * Gated on `leverage_min_delta` so we never burn goodwill over ₹50.
   */
  leverageFor(cpId: string): LeverageLine | null {
    if (!this.pack.capabilities.leverage) return null;
    const mine = this.entries.get(cpId);
    const best = this.bestExternal(cpId);
    if (!best) return null;
    if (mine?.latest !== null && mine?.latest !== undefined) {
      if (mine.latest - best.value < this.pack.tactics.leverage_min_delta) return null;
    }
    const area = best.cp.area ?? best.cp.city ?? "another shop";
    return {
      claim: `another ${best.cp.kind} in ${area} quoted ${formatMoney(best.value)}`,
      value: best.value,
      from_area: area,
      from_cp_id: best.cp.id,
    };
  }

  /** Highest opening number seen anywhere - the honest baseline for savings. */
  firstQuoteMax(): number | null {
    let max: number | null = null;
    for (const e of this.entries.values()) {
      if (e.first === null) continue;
      if (max === null || e.first > max) max = e.first;
    }
    return max;
  }

  latestMax(): number | null {
    let max: number | null = null;
    for (const e of this.entries.values()) {
      if (e.latest === null) continue;
      if (max === null || e.latest > max) max = e.latest;
    }
    return max;
  }

  bestFinal(): { value: number; cp: Counterparty } | null {
    let best: { value: number; cp: Counterparty } | null = null;
    for (const e of this.entries.values()) {
      if (e.dead || e.latest === null) continue;
      if (!best || e.latest < best.value) best = { value: e.latest, cp: e.cp };
    }
    return best;
  }

  all(): BusEntry[] {
    return [...this.entries.values()];
  }

  get(cpId: string): BusEntry | undefined {
    return this.entries.get(cpId);
  }
}

function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(pvt|private|ltd|limited|llp|inc|co|company|studio|the)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function coerce(v: FactValue, type: string): FactValue | null {
  if (v === null) return null;
  switch (type) {
    case "money":
    case "int": {
      const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.-]/g, ""));
      return Number.isFinite(n) ? n : null;
    }
    case "bool":
      if (typeof v === "boolean") return v;
      if (typeof v === "string") return /^(true|yes|haan|ha|available|1)$/i.test(v.trim());
      return Boolean(v);
    default:
      return typeof v === "string" ? v.trim() : String(v);
  }
}

export function formatMoney(n: number): string {
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}
