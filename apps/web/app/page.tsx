"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, rupees } from "@/lib/api";
import type { Skill } from "@/lib/types";

const EXAMPLES = [
  "iPhone 15 128GB under 62k in Koramangala",
  "logo and brand kit under 8k, need it by Friday",
  "2BHK move from HSR to Whitefield on the 20th, under 15k",
];

export default function Home() {
  const router = useRouter();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.stats>> | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testMode, setTestMode] = useState(true);
  const [config, setConfig] = useState<{ test_number: string | null; twilio: boolean } | null>(null);
  const [pending, setPending] = useState<{
    skill_id: string;
    options: { id: string; label: string; emoji: string }[];
    spec: Record<string, string | number>;
    phones: string[];
  } | null>(null);

  useEffect(() => {
    api.skills().then((r) => setSkills(r.skills)).catch((e) => setError(String(e.message)));
    api.health().then((h) => setConfig({ test_number: h.test_number, twilio: h.twilio })).catch(() => undefined);
    api.stats().then(setStats).catch(() => undefined);
  }, []);

  async function submit(overrideSkill?: string) {
    if (!text.trim() && !overrideSkill) return;
    setBusy(true);
    setError(null);

    try {
      const parsed = pending ?? (await api.compose(text));
      const skillId = overrideSkill ?? parsed.skill_id;

      if (skillId === "ask") {
        setPending({ skill_id: "ask", options: parsed.options, spec: parsed.spec, phones: parsed.phones });
        setBusy(false);
        return;
      }

      const started = await api.startMission({
        skill_id: skillId,
        spec: fillDefaults(parsed.spec, skills.find((s) => s.id === skillId)),
        phones: parsed.phones,
        test: testMode,
      });
      router.push(`/mission/${started.mission_id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function runDemo(skillId: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await api.demo(skillId);
      router.push(`/mission/${r.mission_id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <main className="title-screen">
      <div className="scoreboard">
        <span className="px-plate">
          SAVED <b>{rupees(stats?.saved ?? 0)}</b>
        </span>
        <span className="px-plate">
          CALLS <b>{stats?.calls ?? 0}</b>
        </span>
        <span className="px-plate">
          MISSIONS <b>{stats?.missions ?? 0}</b>
        </span>
      </div>

      <h1 className="game-title">
        MOL<em>BHAV</em>
      </h1>
      <p className="game-sub">The bazaar negotiation game</p>

      <div className="px-panel hero-frame">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/game/hero.png" alt="The MolBhav office: four agents on the phones and the manager down front" />
      </div>

      <div className="composer">
        <div className="listener">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/game/manager.png" alt="" aria-hidden />
          <div className="cloud">
            <span className="who">Manager</span>
            {text.trim()
              ? `Got it: "${text.trim().slice(0, 60)}${text.trim().length > 60 ? "…" : ""}" - say the word and I'll brief the team.`
              : "Boss, what are we hunting today? Type it below - I'm listening."}
          </div>
        </div>

        <div className="px-panel chat-bar">
          <span aria-hidden>💬</span>
          <input
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setPending(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="What do you need? e.g. iPhone 15 under 62k in Koramangala"
            aria-label="What do you need?"
            disabled={busy}
          />
          <button className="px-btn" onClick={() => submit()} disabled={busy}>
            {busy ? "Starting…" : "Start mission"}
          </button>
        </div>

        {pending ? (
          <>
            <span className="px-label">Which market is this?</span>
            <div className="quest-chips">
              {pending.options.map((o) => (
                <button key={o.id} className="px-chip" onClick={() => submit(o.id)}>
                  {o.emoji} {o.label}
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="quest-chips">
            {EXAMPLES.map((ex) => (
              <button key={ex} className="px-chip" onClick={() => setText(ex)}>
                {ex}
              </button>
            ))}
          </div>
        )}

        {config?.twilio ? (
          <div className="mode-row">
            <label className="toggle" data-on={testMode}>
              <input type="checkbox" checked={testMode} onChange={(e) => setTestMode(e.target.checked)} />
              <span className="toggle-led" />
              Test mode
            </label>
            <span>
              {testMode ? (
                config.test_number ? (
                  <>
                    rings <b>{config.test_number}</b> instead of the shops, one call at a time
                  </>
                ) : (
                  <>no test number set - add TEST_CALL_REDIRECT to .env</>
                )
              ) : (
                <>calls real shops on the list</>
              )}
            </span>
          </div>
        ) : null}

        {error ? <div className="px-panel error-box">{error}</div> : null}
      </div>

      <section className="level-select">
        <div className="level-head">
          <span className="px-label">Level select · {skills.length} markets installed</span>
          <button
            className="px-btn ghost"
            onClick={async () => {
              const r = await api.reloadSkills();
              setSkills((await api.skills()).skills);
              if (r.errors.length) setError(`${r.errors.length} skill file rejected: ${r.errors[0].message}`);
            }}
          >
            Reload skills
          </button>
        </div>

        <div className="level-grid">
          {skills.map((s) => (
            <button key={s.id} className="px-panel level-card" onClick={() => runDemo(s.id)} disabled={busy}>
              <span className="emoji">{s.emoji}</span>
              <span className="name">{s.label}</span>
              <span className="meta">
                negotiates {s.hero_metric.replace(/_/g, " ")} · demo plays vs simulated shops
              </span>
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}

/** Fill anything the classifier left out so a mission never fails on a missing area. */
function fillDefaults(spec: Record<string, string | number>, skill?: Skill): Record<string, string | number> {
  if (!skill) return spec;
  const out = { ...spec };
  for (const f of skill.mission_fields) {
    if (out[f.key] === undefined && f.default !== undefined) out[f.key] = f.default;
  }
  return out;
}
