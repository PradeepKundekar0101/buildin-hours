"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Rail } from "@/components/Rail";
import { api } from "@/lib/api";
import type { Skill } from "@/lib/types";

const EXAMPLES = [
  "iPhone 15 128GB under 62k in Koramangala",
  "logo and brand kit under 8k, need it by Friday",
  "2BHK move from HSR to Whitefield on the 20th, under 15k",
];

export default function Home() {
  const router = useRouter();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testMode, setTestMode] = useState(true);
  const [config, setConfig] = useState<{ test_number: string | null; twilio: boolean } | null>(null);
  const [pending, setPending] = useState<{ skill_id: string; options: { id: string; label: string; emoji: string }[]; spec: Record<string, string | number>; phones: string[] } | null>(null);

  useEffect(() => {
    api.skills().then((r) => setSkills(r.skills)).catch((e) => setError(String(e.message)));
    api.health().then((h) => setConfig({ test_number: h.test_number, twilio: h.twilio })).catch(() => undefined);
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
    <>
      <Rail />
      <main className="shell">
        <section className="hero">
          <div className="eyebrow">One engine · every bazaar</div>
          <h1 className="headline">
            India negotiates by phone.
            <br />
            <em>So does this.</em>
          </h1>
          <p className="subhead">
            Tell MolBhav what you need. It finds the shops, calls six of them at once in whatever language
            they answer in, and lets each call use what the others just learned.
          </p>

          <div className="composer">
            <div className="composer-box">
              <input
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setPending(null);
                }}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                placeholder="What do you need?"
                aria-label="What do you need?"
                disabled={busy}
              />
              <button className="btn" onClick={() => submit()} disabled={busy}>
                {busy ? "Starting…" : "Start calling"}
              </button>
            </div>

            {pending ? (
              <>
                <p className="section-label" style={{ marginTop: 18 }}>
                  Which market is this?
                </p>
                <div className="chips">
                  {pending.options.map((o) => (
                    <button key={o.id} className="chip" onClick={() => submit(o.id)}>
                      {o.emoji} {o.label}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className="chips">
                {EXAMPLES.map((ex) => (
                  <button key={ex} className="chip" onClick={() => setText(ex)}>
                    {ex}
                  </button>
                ))}
              </div>
            )}

            {config?.twilio ? (
              <div className="mode-row">
                <label className="toggle" data-on={testMode}>
                  <input
                    type="checkbox"
                    checked={testMode}
                    onChange={(e) => setTestMode(e.target.checked)}
                  />
                  <span className="toggle-led" />
                  Test mode
                </label>
                <span className="mode-note">
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

            {error ? <div className="error">{error}</div> : null}
          </div>
        </section>

        <section className="shelf">
          <div className="shelf-head">
            <span className="section-label">
              {skills.length} markets installed · each one is a file, not a feature
            </span>
            <button
              className="btn-ghost"
              onClick={async () => {
                const r = await api.reloadSkills();
                setSkills((await api.skills()).skills);
                if (r.errors.length) setError(`${r.errors.length} skill file rejected: ${r.errors[0].message}`);
              }}
            >
              Reload skills
            </button>
          </div>

          <div className="skill-grid">
            {skills.map((s) => (
              <button key={s.id} className="skill-card" onClick={() => runDemo(s.id)} disabled={busy}>
                <span className="skill-emoji">{s.emoji}</span>
                <span className="skill-name">{s.label}</span>
                <span className="skill-meta">
                  negotiates {s.hero_metric.replace(/_/g, " ")} · {s.columns.length} tracked facts
                </span>
              </button>
            ))}
          </div>
        </section>
      </main>
    </>
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
