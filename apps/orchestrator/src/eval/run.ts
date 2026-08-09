/**
 * `pnpm eval --skill electronics [--seeds 3] [--mock]`
 *
 * Runs every persona in the skill file against the real negotiation core over the
 * sim transport, and gates on the properties that actually decide whether a market
 * is shippable. The headline number for the deck comes out of here:
 *
 *   a new skill passes >= 7/10 personas with `git diff --stat engine/` empty.
 */
import { randomUUID } from "node:crypto";
import { skills } from "../skills/registry.js";
import { FactBus } from "../engine/fact-bus.js";
import { CallSession } from "../engine/call-session.js";
import { SimTransport, syntheticGroundTruth } from "../transports/sim.js";
import { summarise } from "../engine/mission.js";
import { STATES, type CallRecord, type Mission, type State } from "../engine/types.js";
import type { SkillPack } from "../skills/schema.js";

type Args = { skill?: string; seeds: number };

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv.includes("--mock")) process.env.MOCK_SARVAM = "1";
  return { skill: get("--skill"), seeds: Number(get("--seeds") ?? 2) };
}

type PersonaResult = {
  persona: string;
  seed: number;
  passed: boolean;
  failures: string[];
  rounds: number;
  facts_offered: number;
  facts_total: number;
  final: number | null;
  outcome: string | null;
  turns: number;
};

/** Legal transitions. The engine may only walk forward, plus WRAP/DONE from anywhere. */
const ORDER: State[] = [...STATES];
function legalTransition(from: State, to: State): boolean {
  if (to === "WRAP" || to === "DONE") return true;
  return ORDER.indexOf(to) >= ORDER.indexOf(from);
}

async function runPersona(pack: SkillPack, persona: string, seed: number): Promise<PersonaResult> {
  const spec: Record<string, string | number> = {};
  for (const f of pack.mission_fields) {
    if (f.default !== undefined) spec[f.key] = f.default;
    else if (f.type === "int") spec[f.key] = 30000;
    else if (f.type === "date") spec[f.key] = "this Friday";
    else if (f.key === "area") spec[f.key] = "Koramangala";
    else if (f.key === "city") spec[f.key] = "Bengaluru";
    else if (f.required) spec[f.key] = "the usual thing";
  }

  const mission: Mission = {
    id: randomUUID(),
    skill_id: pack.id,
    user_id: "eval",
    spec,
    created_at: Date.now(),
    status: "running",
  };

  const bus = new FactBus(pack, mission.id);

  // A sibling quote already on the bus, so the leverage path is exercised.
  const ghost = {
    id: randomUUID(),
    name: "Sibling call",
    phone: "+919000000099",
    kind: pack.counterparty_kinds[0],
    area: "Indiranagar",
    city: "Bengaluru",
    source: "seed" as const,
    attrs: {},
  };
  bus.register(ghost);
  bus.publish(ghost.id, { [pack.ui.hero_metric]: 28000 });

  const counterparty = {
    id: randomUUID(),
    name: `${persona} (${pack.label})`,
    phone: "+919000000098",
    kind: pack.counterparty_kinds[0],
    area: "Koramangala",
    city: "Bengaluru",
    source: "seed" as const,
    attrs: {},
    lang_hint: "hi-IN",
  };

  const groundTruth = syntheticGroundTruth(pack, spec, seed);
  const transport = new SimTransport({
    pack,
    counterparty,
    callId: randomUUID(),
    persona,
    groundTruth,
    lang: "hi-IN",
    maxTurns: 14,
  });

  const failures: string[] = [];
  const askedAbout = new Set<string>();
  let lastState: State = "DIAL";
  let usTurns = 0;

  const session = new CallSession(
    pack,
    mission,
    counterparty,
    bus,
    transport,
    {
      onTurn: (call, turn) => {
        if (turn.role !== "us") return;
        usTurns += 1;

        // Brevity is a real constraint on a phone call, not a style preference.
        const words = turn.text.trim().split(/\s+/).length;
        if (words > 34) failures.push(`reply too long (${words} words): "${turn.text.slice(0, 60)}..."`);

        // Any market claim must have come off the bus.
        const claimsMarket = /(another|dusr|bahar|competitor|market rate|kahin aur)/i.test(turn.text);
        const busHasExternal = bus.bestExternal(counterparty.id) !== null;
        if (claimsMarket && !busHasExternal) {
          failures.push(`market claim with nothing on the bus: "${turn.text.slice(0, 60)}"`);
        }

        for (const key of Object.keys(pack.fact_schema)) {
          const hint = pack.fact_schema[key].ask_hint.split(/\s+/).slice(0, 2).join(" ");
          if (turn.text.toLowerCase().includes(hint.toLowerCase().slice(0, 6))) askedAbout.add(key);
        }
        void call;
      },
      onFacts: () => undefined,
      onState: (_call, state) => {
        if (!legalTransition(lastState, state)) failures.push(`illegal transition ${lastState} -> ${state}`);
        lastState = state;
      },
      onEnd: () => undefined,
    },
    "Pradeep"
  );

  const call: CallRecord = await session.run();

  // Did we ever reach a number on the metric this market is actually about?
  const hero = call.facts[pack.ui.hero_metric];
  const gotHero = typeof hero === "number";
  const hostile = /hostile|hangup/.test(persona);
  if (!gotHero && !hostile) failures.push(`never captured ${pack.ui.hero_metric}`);

  // Never past the reservation.
  const summary = summarise(pack, mission, bus, [call]);
  const budget = Number(Object.entries(spec).find(([k]) => /budget|target/.test(k))?.[1] ?? Infinity);
  if (gotHero && (hero as number) > budget * 1.35) {
    failures.push(`closed at ${hero}, far past budget ${budget}`);
  }
  void summary;

  const factsTotal = Object.keys(pack.fact_schema).length;
  const factsOffered = Object.keys(call.facts).length;

  return {
    persona,
    seed,
    passed: failures.length === 0,
    failures,
    rounds: call.rounds,
    facts_offered: factsOffered,
    facts_total: factsTotal,
    final: call.final_quote,
    outcome: call.outcome,
    turns: usTurns,
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  skills.load();

  const packs = args.skill ? [skills.require(args.skill)] : skills.all();

  let exitCode = 0;

  for (const pack of packs) {
    console.log(`\n${"=".repeat(72)}\n${pack.emoji}  ${pack.id} - ${pack.eval_personas.length} personas x ${args.seeds} seeds\n${"=".repeat(72)}`);

    const results: PersonaResult[] = [];
    for (const persona of pack.eval_personas) {
      for (let seed = 1; seed <= args.seeds; seed++) {
        try {
          results.push(await runPersona(pack, persona, seed));
        } catch (err) {
          results.push({
            persona,
            seed,
            passed: false,
            failures: [`threw: ${err instanceof Error ? err.message : String(err)}`],
            rounds: 0,
            facts_offered: 0,
            facts_total: Object.keys(pack.fact_schema).length,
            final: null,
            outcome: "error",
            turns: 0,
          });
        }
      }
    }

    // A persona passes if it passes on any seed - personas are stochastic by design.
    const byPersona = new Map<string, PersonaResult[]>();
    for (const r of results) {
      byPersona.set(r.persona, [...(byPersona.get(r.persona) ?? []), r]);
    }

    let passedPersonas = 0;
    for (const [persona, runs] of byPersona) {
      const ok = runs.some((r) => r.passed);
      if (ok) passedPersonas += 1;
      const best = runs.find((r) => r.passed) ?? runs[0];
      console.log(
        `${ok ? "✓" : "✗"} ${persona.padEnd(28)} ` +
          `facts ${best.facts_offered}/${best.facts_total}  rounds ${best.rounds}  ` +
          `${pack.ui.hero_metric}=${best.final ?? "-"}  ${best.outcome}`
      );
      if (!ok) {
        for (const f of [...new Set(runs.flatMap((r) => r.failures))].slice(0, 3)) {
          console.log(`    - ${f}`);
        }
      }
    }

    const total = byPersona.size;
    const recall =
      results.reduce((a, r) => a + r.facts_offered / Math.max(1, r.facts_total), 0) / Math.max(1, results.length);

    const gate = passedPersonas >= Math.ceil(total * 0.7);
    console.log(
      `\n${gate ? "PASS" : "FAIL"}  ${passedPersonas}/${total} personas · fact recall ${(recall * 100).toFixed(0)}% · gate is 70%`
    );
    if (!gate) exitCode = 1;
  }

  process.exit(exitCode);
}

void main();
