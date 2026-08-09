import { randomUUID } from "node:crypto";
import type { SkillPack } from "../skills/schema.js";
import { FactBus, formatMoney } from "./fact-bus.js";
import { CallSession } from "./call-session.js";
import { evaluateFormula } from "./formula.js";
import { SimTransport, syntheticGroundTruth } from "../transports/sim.js";
import { TwilioTransport, liveTwilioTransports } from "../transports/twilio.js";
import { warmFillers } from "../sarvam/tts.js";
import type { Transport } from "./transport.js";
import type { CallRecord, Counterparty, Mission, MissionSpec } from "./types.js";
import { env, has } from "../env.js";
import { log } from "../log.js";
import { bus as events } from "../events.js";
import { persist } from "../db/repo.js";

/**
 * Runs one mission: N counterparties, up to MAX_PARALLEL_CALLS at a time, all
 * publishing into one Fact Bus so a number learned on line 3 is leverage on line 1.
 */

export type MissionRun = {
  mission: Mission;
  pack: SkillPack;
  bus: FactBus;
  calls: Map<string, CallRecord>;
  sessions: CallSession[];
  done: Promise<MissionSummary>;
};

export type MissionSummary = {
  mission_id: string;
  skill_id: string;
  best: { value: number; counterparty: Counterparty; call: CallRecord } | null;
  savings: number | null;
  savings_label: string;
  calls: CallRecord[];
  dead_leads: number;
  duplicates: number;
};

const runs = new Map<string, MissionRun>();

export function getRun(id: string): MissionRun | undefined {
  return runs.get(id);
}

export function allRuns(): MissionRun[] {
  return [...runs.values()];
}

export async function startMission(args: {
  pack: SkillPack;
  spec: MissionSpec;
  counterparties: Counterparty[];
  userId: string;
  userPhone?: string;
  firstName?: string;
  /** Force the simulator even when Twilio is configured (rehearsal, evals, fallback). */
  mode?: "pstn" | "sim";
  /** Test mode: real telephony, but every call rings this number instead of the shop. */
  testRedirect?: string;
}): Promise<MissionRun> {
  const { pack } = args;
  const testRedirect = args.testRedirect?.trim() || undefined;

  const mission: Mission = {
    id: randomUUID(),
    skill_id: pack.id,
    user_id: args.userId,
    user_phone: args.userPhone,
    spec: args.spec,
    created_at: Date.now(),
    status: "running",
    test: Boolean(testRedirect),
  };

  const useSim = args.mode === "sim" || (!has.twilio() && args.mode !== "pstn");
  const bus = new FactBus(pack, mission.id);
  const calls = new Map<string, CallRecord>();
  const sessions: CallSession[] = [];

  log.info(
    `mission ${mission.id.slice(0, 8)} · ${pack.emoji} ${pack.id} · ${args.counterparties.length} counterparties · ${useSim ? "SIM" : "PSTN"}` +
      (testRedirect ? ` · TEST MODE -> every call rings ${testRedirect}, no shop is dialled` : "")
  );

  events.emit(mission.id, {
    type: "mission.start",
    skill: pack.id,
    mission_id: mission.id,
    spec: args.spec,
    ui: pack.ui,
    counterparties: args.counterparties,
    test: mission.test,
    test_redirect: testRedirect ?? null,
  });
  void persist.mission(mission);

  // Relay bus activity straight to the theater: this is the arbitrage beat on screen.
  bus.on("event", (e) => {
    if (e.type === "best") {
      events.emit(mission.id, { type: "ticker", skill: pack.id, cp_id: e.cp_id, field: e.field, value: e.value });
    } else if (e.type === "dead_lead") {
      events.emit(mission.id, { type: "dead_lead", skill: pack.id, cp_id: e.cp_id });
    } else if (e.type === "dedup") {
      events.emit(mission.id, { type: "dedup", skill: pack.id, cp_id: e.cp_id, duplicate_of: e.duplicate_of });
    }
  });

  // Pre-synthesise openers and fillers so the first second of every call is free.
  const langs = [...new Set(args.counterparties.map((c) => c.lang_hint ?? "en-IN").concat("en-IN"))];
  void warmFillers(pack, langs).catch(() => undefined);

  const firstName = args.firstName ?? "the customer";

  const runOne = async (cp: Counterparty, index: number): Promise<CallRecord> => {
    const callId = randomUUID();
    const openingLang = cp.lang_hint ?? "en-IN";

    let transport: Transport;
    if (useSim) {
      transport = new SimTransport({
        pack,
        counterparty: cp,
        callId,
        persona: pack.eval_personas[index % pack.eval_personas.length],
        groundTruth: syntheticGroundTruth(pack, args.spec, index + 1),
        lang: openingLang,
        replyDelayMs: 250,
      });
    } else {
      const t = new TwilioTransport({ pack, counterparty: cp, callId, openingLang, dialOverride: testRedirect });
      liveTwilioTransports.set(callId, t);
      transport = t;
    }

    const session = new CallSession(pack, mission, cp, bus, transport, {
      onTurn: (call, turn) => {
        events.emit(mission.id, {
          type: "turn",
          skill: pack.id,
          call_id: call.id,
          cp_id: cp.id,
          role: turn.role,
          text: turn.text,
          lang: turn.lang,
          latency_ms: turn.latency_ms,
        });
      },
      onFacts: (call, delta) => {
        events.emit(mission.id, { type: "fact.cell", skill: pack.id, call_id: call.id, cp_id: cp.id, facts: delta });
      },
      onState: (call, state) => {
        events.emit(mission.id, { type: "call.state", skill: pack.id, call_id: call.id, cp_id: cp.id, state });
      },
      onEnd: (call) => {
        calls.set(call.id, call);
        liveTwilioTransports.delete(callId);
        events.emit(mission.id, {
          type: "call.end",
          skill: pack.id,
          call_id: call.id,
          cp_id: cp.id,
          outcome: call.outcome,
          final: call.final_quote,
          recording_url: call.recording_url,
        });
        void persist.call(call);
      },
    }, firstName);

    sessions.push(session);
    calls.set(session.call.id, session.call);

    try {
      return await session.run();
    } catch (err) {
      log.error(`call to ${cp.name} blew up: ${err instanceof Error ? err.message : err}`);
      return session.call;
    }
  };

  // One human cannot answer six phones. In test mode the calls queue up and ring
  // one at a time, so the whole roster is still exercised.
  const parallel = testRedirect ? 1 : env.maxParallelCalls;

  const done = (async (): Promise<MissionSummary> => {
    await pool(args.counterparties, parallel, runOne);
    mission.status = "done";

    const summary = summarise(pack, mission, bus, [...calls.values()]);
    events.emit(mission.id, { type: "mission.end", skill: pack.id, ...summary });
    void persist.summary(summary);
    log.info(
      `mission ${mission.id.slice(0, 8)} done · best ${summary.best ? formatMoney(summary.best.value) : "none"} · saved ${summary.savings ?? "-"}`
    );
    return summary;
  })();

  const run: MissionRun = { mission, pack, bus, calls, sessions, done };
  runs.set(mission.id, run);
  return run;
}

export function summarise(pack: SkillPack, mission: Mission, bus: FactBus, calls: CallRecord[]): MissionSummary {
  const best = bus.bestFinal();
  const hero = pack.ui.hero_metric;

  // Variables a savings_formula may reference, built generically from the bus.
  const vars: Record<string, number | null> = {
    first_quote_max: bus.firstQuoteMax(),
    [`max_${hero}`]: bus.latestMax(),
    max_quote: bus.latestMax(),
    [`best_final_${hero}`]: best?.value ?? null,
    best_final_quote: best?.value ?? null,
    best_final: best?.value ?? null,
  };
  for (const [k, v] of Object.entries(mission.spec)) {
    const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.-]/g, ""));
    vars[`spec.${k}`] = Number.isFinite(n) ? n : null;
  }

  const { value: savings, missing } = evaluateFormula(pack.savings_formula, vars);
  if (missing.length) {
    log.warn(`savings_formula for ${pack.id} could not resolve: ${[...new Set(missing)].join(", ")}`);
  }

  const bestCall = best ? calls.find((c) => c.counterparty.id === best.cp.id) ?? null : null;

  return {
    mission_id: mission.id,
    skill_id: pack.id,
    best: best && bestCall ? { value: best.value, counterparty: best.cp, call: bestCall } : null,
    savings: savings !== null && savings > 0 ? Math.round(savings) : null,
    savings_label: pack.savings_formula.includes(":=")
      ? pack.savings_formula.slice(0, pack.savings_formula.indexOf(":=")).trim()
      : "saved",
    calls,
    dead_leads: calls.filter((c) => c.outcome === "dead_lead").length,
    duplicates: calls.filter((c) => c.outcome === "duplicate").length,
  };
}

/** Bounded concurrency, preserving input order in the results. */
async function pool<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}
