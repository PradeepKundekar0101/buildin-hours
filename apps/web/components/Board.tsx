"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { rupees } from "@/lib/api";
import { useMissionStream } from "@/lib/useMissionStream";
import type { Column, Counterparty, Line } from "@/lib/types";

/**
 * The board. One row per open line, the tape above it, the running best beside it.
 *
 * Ticker markets and facts-heavy markets render from the same component, switched
 * only by `mode` off the skill file - there is no per-market frontend code anywhere
 * in this app.
 */
export function Board({
  missionId,
  counterparties,
  heroMetric,
  columns,
  mode,
  title,
  spec,
}: {
  missionId: string;
  counterparties: Counterparty[];
  heroMetric: string;
  columns: Column[];
  mode: "ticker" | "table";
  title: string;
  spec: Record<string, unknown>;
}) {
  const s = useMissionStream(missionId, heroMetric, counterparties);
  const lines = s.order.map((id) => s.lines.get(id)).filter(Boolean) as Line[];
  const openCount = lines.filter((l) => !l.ended).length;

  return (
    <>
      <div className="mission-head">
        <h1 className="mission-title">{title}</h1>
        <span className="live-pill">
          {openCount > 0 ? (
            <>
              <span className="live-dot" />
              {openCount} {openCount === 1 ? "line open" : "lines open"}
            </>
          ) : s.ended ? (
            `${lines.length} calls done`
          ) : (
            "connecting"
          )}
        </span>
        <span className="mission-spec">
          {Object.entries(spec)
            .filter(([, v]) => v !== undefined && v !== "")
            .map(([k, v]) => `${k}: ${v}`)
            .join("  ·  ")}
        </span>
      </div>

      <Tape items={s.tape} />

      <div className="theater">
        <div>
          <Lines lines={lines} arcs={s.arcs} heroMetric={heroMetric} />
          {mode === "table" || lines.some((l) => Object.keys(l.facts).length > 1) ? (
            <FactTable lines={lines} columns={columns} />
          ) : null}
        </div>

        <aside>
          <div className="panel">
            <div className="section-label">Best so far</div>
            <div className="best-value">{s.best ? rupees(s.best.value) : "-"}</div>
            <div className="best-from">
              {s.best ? (
                <>
                  {s.lines.get(s.best.cpId)?.cp.name ?? "a line"}
                  {s.firstMax && s.firstMax > s.best.value ? (
                    <>
                      {" "}
                      · opened at <s>{rupees(s.firstMax)}</s>
                    </>
                  ) : null}
                </>
              ) : (
                "Waiting for the first number."
              )}
            </div>
            {s.savings ? <div className="saved-pill">{rupees(s.savings)} below the highest quote</div> : null}
          </div>

          <div className="panel">
            <div className="section-label">Lines</div>
            <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
              {lines.map((l) => (
                <div key={l.cp.id} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <span style={{ fontSize: 13, color: "var(--chalk-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {l.cp.name}
                  </span>
                  <span className="line-state" data-state={l.state}>
                    {l.outcome ?? l.state}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {s.ended ? <Outcome lines={lines} savings={s.savings} best={s.best} heroMetric={heroMetric} /> : null}
        </aside>
      </div>

      {!s.connected && !s.ended ? <p className="mission-spec" style={{ marginTop: 16 }}>Reconnecting to the board…</p> : null}
      {openCount === 0 && s.ended ? null : null}
    </>
  );
}

/* ------------------------------------------------------------------ the tape */

function Tape({ items }: { items: { id: number; kind: string; text: string; value?: string }[] }) {
  const recent = items.slice(-6);
  if (!recent.length) {
    return (
      <div className="tape">
        <div className="tape-inner">
          <span className="tape-item">waiting for the first fact…</span>
        </div>
      </div>
    );
  }
  return (
    <div className="tape">
      <div className="tape-inner" key={recent.at(-1)?.id}>
        {recent.map((i) => (
          <span className="tape-item" key={i.id} data-kind={i.kind}>
            {i.text} <b>{i.value}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------- lines + the leverage arc */

function Lines({
  lines,
  arcs,
  heroMetric,
}: {
  lines: Line[];
  arcs: { id: number; fromCpId: string; toCpId: string; label: string }[];
  heroMetric: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const [paths, setPaths] = useState<{ id: number; d: string; label: string; x: number; y: number }[]>([]);

  useLayoutEffect(() => {
    const container = wrap.current;
    if (!container || !arcs.length) return;

    const box = container.getBoundingClientRect();
    const next = arcs
      .map((arc) => {
        const from = rowRefs.current.get(arc.fromCpId)?.getBoundingClientRect();
        const to = rowRefs.current.get(arc.toCpId)?.getBoundingClientRect();
        if (!from || !to) return null;
        const x1 = from.right - box.left - 150;
        const y1 = from.top - box.top + from.height / 2;
        const x2 = to.right - box.left - 150;
        const y2 = to.top - box.top + to.height / 2;
        // Bow the curve out to the left so it reads as a patch cable, not a chord.
        const bow = Math.min(90, Math.abs(y2 - y1) * 0.7 + 26);
        return {
          id: arc.id,
          d: `M ${x1} ${y1} C ${x1 - bow} ${y1}, ${x2 - bow} ${y2}, ${x2} ${y2}`,
          label: arc.label,
          x: Math.min(x1, x2) - bow - 4,
          y: (y1 + y2) / 2,
        };
      })
      .filter(Boolean) as { id: number; d: string; label: string; x: number; y: number }[];

    setPaths(next);
    const t = setTimeout(() => setPaths([]), 1700);
    return () => clearTimeout(t);
  }, [arcs]);

  if (!lines.length) {
    return <div className="empty">No lines open yet. The engine is still finding numbers to call.</div>;
  }

  return (
    <div className="lines" ref={wrap}>
      {paths.length ? (
        <svg className="arc-layer">
          {paths.map((p) => (
            <g key={p.id}>
              <path className="arc-path" d={p.d} />
              <text className="arc-label" x={Math.max(6, p.x)} y={p.y - 6} textAnchor="end">
                {p.label} →
              </text>
            </g>
          ))}
        </svg>
      ) : null}

      {lines.map((line, i) => (
        <div
          key={line.cp.id}
          className="line-card"
          data-live={!line.ended}
          data-dead={line.dead}
          ref={(el) => {
            if (el) rowRefs.current.set(line.cp.id, el);
          }}
        >
          <span className="line-no">{String(i + 1).padStart(2, "0")}</span>

          <div style={{ minWidth: 0 }}>
            <div className="line-name">
              {line.cp.name}
              {line.lang ? <span className="lang-tag">{line.lang.replace("-IN", "")}</span> : null}
            </div>
            <div className="line-say" data-role={line.lastRole}>
              {line.lastText || (line.ended ? "line closed" : "dialling…")}
            </div>
          </div>

          <div className="line-right">
            <span className="line-value" data-moved={line.value !== null} key={line.value ?? "none"}>
              {line.value === null ? "—" : rupees(line.value)}
            </span>
            <span className="line-state" data-state={line.state}>
              {line.outcome ?? line.state}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------- the fact grid */

function FactTable({ lines, columns }: { lines: Line[]; columns: Column[] }) {
  if (!columns.length) return null;
  return (
    <div className="facts-wrap">
      <table className="facts">
        <thead>
          <tr>
            <th>Who</th>
            {columns.map((c) => (
              <th key={c.key}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.cp.id} data-dead={l.dead}>
              <td className="name">{l.cp.name}</td>
              {columns.map((c) => {
                const v = l.facts[c.key];
                const pending = v === undefined || v === null;
                return (
                  <td key={c.key} className={pending ? "pending" : ""} data-fresh={l.freshFields.has(c.key)}>
                    {pending ? "—" : format(v, c.type)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function format(v: unknown, type: string): string {
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (type === "money" && typeof v === "number") return rupees(v);
  return String(v);
}

/* ----------------------------------------------------------- the outcome card */

function Outcome({
  lines,
  savings,
  best,
  heroMetric,
}: {
  lines: Line[];
  savings: number | null;
  best: { value: number; cpId: string } | null;
  heroMetric: string;
}) {
  const winner = lines.find((l) => l.cp.id === best?.cpId);
  const recordings = lines.filter((l) => l.recording);

  return (
    <div className="outcome">
      <div className="section-label">Result</div>
      <h2>{winner ? winner.cp.name : "No deal closed"}</h2>
      <p className="mission-spec">
        {winner
          ? `${winner.cp.area ?? winner.cp.city ?? "nearby"} · ${winner.cp.phone}`
          : "Nobody gave us a workable number. Try more numbers, or widen the area."}
      </p>

      <div className="outcome-grid">
        <div className="outcome-cell stat">
          <span className="stat-value">{best ? rupees(best.value) : "-"}</span>
          <span className="stat-label">final {heroMetric.replace(/_/g, " ")}</span>
        </div>
        <div className="outcome-cell stat">
          <span className="stat-value">{savings ? rupees(savings) : "-"}</span>
          <span className="stat-label">saved</span>
        </div>
        <div className="outcome-cell stat">
          <span className="stat-value">{lines.filter((l) => !l.dead).length}</span>
          <span className="stat-label">lines answered</span>
        </div>
      </div>

      {recordings.map((l) => (
        <a key={l.cp.id} className="recording" href={l.recording} target="_blank" rel="noreferrer">
          ▸ hear the call with {l.cp.name}
        </a>
      ))}
    </div>
  );
}
