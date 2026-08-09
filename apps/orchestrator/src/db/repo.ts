import { sb } from "./supabase.js";
import { log } from "../log.js";
import type { CallRecord, Mission } from "../engine/types.js";
import type { MissionSummary } from "../engine/mission.js";

/**
 * Persistence is fire-and-forget on purpose: a Supabase hiccup must never stall a
 * live call. Counters and the Bhav Index read from these tables; the theater does not.
 */

const memory = {
  missions: [] as Mission[],
  calls: [] as CallRecord[],
  summaries: [] as MissionSummary[],
};

async function safe(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log.warn(`persist ${label} failed: ${err instanceof Error ? err.message : err}`);
  }
}

export const persist = {
  async mission(m: Mission): Promise<void> {
    memory.missions.push(m);
    const client = sb();
    if (!client) return;
    await safe("mission", async () => {
      const { error } = await client.from("missions").insert({
        id: m.id,
        skill_id: m.skill_id,
        user_id: m.user_id,
        spec: m.spec,
        status: m.status,
        created_at: new Date(m.created_at).toISOString(),
      });
      if (error) throw new Error(error.message);
    });
  },

  async call(c: CallRecord): Promise<void> {
    memory.calls.push(c);
    const client = sb();
    if (!client) return;
    await safe("call", async () => {
      const { error } = await client.from("calls").insert({
        id: c.id,
        mission_id: c.mission_id,
        counterparty_name: c.counterparty.name,
        counterparty_phone: c.counterparty.phone,
        counterparty_kind: c.counterparty.kind,
        area: c.counterparty.area,
        city: c.counterparty.city,
        source: c.counterparty.source,
        lang: c.lang,
        state: c.state,
        outcome: c.outcome,
        rounds: c.rounds,
        first_quote: c.first_quote,
        final_quote: c.final_quote,
        facts: c.facts,
        transcript: c.transcript,
        recording_url: c.recording_url,
        started_at: new Date(c.started_at).toISOString(),
        ended_at: c.ended_at ? new Date(c.ended_at).toISOString() : null,
      });
      if (error) throw new Error(error.message);
    });
  },

  async summary(s: MissionSummary): Promise<void> {
    memory.summaries.push(s);
    const client = sb();
    if (!client) return;
    await safe("summary", async () => {
      const { error } = await client
        .from("missions")
        .update({
          status: "done",
          savings: s.savings,
          best_value: s.best?.value ?? null,
          best_counterparty: s.best?.counterparty.name ?? null,
        })
        .eq("id", s.mission_id);
      if (error) throw new Error(error.message);
    });
  },
};

/** Cross-category counters. Falls back to in-memory when Supabase is absent. */
export async function publicStats(): Promise<{
  users: number;
  missions: number;
  calls: number;
  saved: number;
  dead_leads: number;
  by_skill: Record<string, { missions: number; saved: number }>;
}> {
  const client = sb();
  if (!client) {
    const by_skill: Record<string, { missions: number; saved: number }> = {};
    for (const s of memory.summaries) {
      const e = (by_skill[s.skill_id] ??= { missions: 0, saved: 0 });
      e.missions += 1;
      e.saved += s.savings ?? 0;
    }
    return {
      users: new Set(memory.missions.map((m) => m.user_id)).size,
      missions: memory.missions.length,
      calls: memory.calls.length,
      saved: memory.summaries.reduce((a, s) => a + (s.savings ?? 0), 0),
      dead_leads: memory.calls.filter((c) => c.outcome === "dead_lead").length,
      by_skill,
    };
  }

  const [missions, calls] = await Promise.all([
    client.from("missions").select("skill_id,user_id,savings"),
    client.from("calls").select("outcome"),
  ]);

  const rows = (missions.data ?? []) as { skill_id: string; user_id: string; savings: number | null }[];
  const callRows = (calls.data ?? []) as { outcome: string | null }[];

  const by_skill: Record<string, { missions: number; saved: number }> = {};
  for (const r of rows) {
    const e = (by_skill[r.skill_id] ??= { missions: 0, saved: 0 });
    e.missions += 1;
    e.saved += r.savings ?? 0;
  }

  return {
    users: new Set(rows.map((r) => r.user_id)).size,
    missions: rows.length,
    calls: callRows.length,
    saved: rows.reduce((a, r) => a + (r.savings ?? 0), 0),
    dead_leads: callRows.filter((c) => c.outcome === "dead_lead").length,
    by_skill,
  };
}

/** Bhav Index: median closing price per (skill, item/area). */
export async function bhavIndex(skillId?: string): Promise<
  { skill_id: string; group: string; samples: number; median: number; low: number; high: number }[]
> {
  const client = sb();
  const rows: { skill_id: string; group: string; value: number }[] = [];

  if (client) {
    const { data } = await client
      .from("calls")
      .select("final_quote,area,mission_id,missions(skill_id,spec)")
      .not("final_quote", "is", null);
    for (const r of (data ?? []) as never[]) {
      const row = r as { final_quote: number; area?: string; missions?: { skill_id: string; spec: Record<string, unknown> } };
      if (!row.missions) continue;
      const label = String(row.missions.spec?.item ?? row.missions.spec?.gig ?? row.missions.spec?.item_spec ?? row.area ?? "all");
      rows.push({ skill_id: row.missions.skill_id, group: label, value: row.final_quote });
    }
  } else {
    for (const s of memory.summaries) {
      for (const c of s.calls) {
        if (typeof c.final_quote === "number") {
          rows.push({ skill_id: s.skill_id, group: c.counterparty.area ?? "all", value: c.final_quote });
        }
      }
    }
  }

  const grouped = new Map<string, { skill_id: string; group: string; values: number[] }>();
  for (const r of rows) {
    if (skillId && r.skill_id !== skillId) continue;
    const key = `${r.skill_id}|${r.group}`;
    const e = grouped.get(key) ?? { skill_id: r.skill_id, group: r.group, values: [] };
    e.values.push(r.value);
    grouped.set(key, e);
  }

  return [...grouped.values()]
    .map((g) => {
      const sorted = g.values.sort((a, b) => a - b);
      return {
        skill_id: g.skill_id,
        group: g.group,
        samples: sorted.length,
        median: sorted[Math.floor(sorted.length / 2)],
        low: sorted[0],
        high: sorted[sorted.length - 1],
      };
    })
    .sort((a, b) => b.samples - a.samples);
}
