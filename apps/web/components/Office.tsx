"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { rupees } from "@/lib/api";
import { useMissionStream } from "@/lib/useMissionStream";
import type { Counterparty, Line } from "@/lib/types";

/**
 * The office. One desk per open line, the manager down front, everything the
 * engine does narrated through speech clouds. This replaces the old board; the
 * mission stream underneath is unchanged.
 */

const WORKER_SPRITES = ["/game/worker-1.png", "/game/worker-2.png", "/game/worker-3.png"];

/** The office is built for four agents; unstaffed slots show an empty desk. */
const DESK_COUNT = 4;

export function Office({
  missionId,
  counterparties,
  heroMetric,
  title,
  spec,
}: {
  missionId: string;
  counterparties: Counterparty[];
  heroMetric: string;
  title: string;
  spec: Record<string, unknown>;
}) {
  const router = useRouter();
  const s = useMissionStream(missionId, heroMetric, counterparties);
  const lines = s.order.map((id) => s.lines.get(id)).filter(Boolean) as Line[];

  const [openDesk, setOpenDesk] = useState<string | null>(null);
  const [resultsDismissed, setResultsDismissed] = useState(false);

  const anyTurns = lines.some((l) => l.turns.length > 0);
  const briefing = !s.ended && !anyTurns;
  const spots = deskSpots(Math.max(lines.length, DESK_COUNT));
  const specText = summariseSpec(spec);

  const openLine = openDesk ? lines.find((l) => l.cp.id === openDesk) : null;
  const winner = s.best ? lines.find((l) => l.cp.id === s.best!.cpId) : null;

  return (
    <div className="game-shell">
      <aside className="side">
        <div className="px-panel side-panel best-box">
          <span className="px-label">Best price so far</span>
          <span className="value">{s.best ? rupees(s.best.value) : "—"}</span>
          <span className="from">
            {winner
              ? winner.cp.name
              : s.connected || anyTurns
                ? "waiting for the first quote"
                : "connecting to the office…"}
          </span>
        </div>

        <div className="px-panel side-panel">
          <span className="px-label">Agents</span>
          {lines.map((l, i) => (
            <div key={l.cp.id} className="agent-row" data-status={agentStatus(l)}>
              <span className="led" />
              <span className="name">
                Desk {i + 1} · {l.cp.name}
              </span>
              <span className="price">{l.value !== null ? rupees(l.value) : ""}</span>
            </div>
          ))}
          {!lines.length ? <div className="agent-row">No desks staffed yet.</div> : null}
        </div>

        <div className="px-panel side-panel logs">
          <span className="px-label">Mission log</span>
          <LogFeed lines={lines} tape={s.tape} />
        </div>
      </aside>

      <div className="scene-wrap">
        {s.test ? (
          <div className="px-panel test-strip">
            <b>Test run</b>
            Every call rings {s.testRedirect ?? "the test number"}, one at a time. No shop is dialled.
          </div>
        ) : null}

        <div className="px-panel office">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="office-bg" src="/game/office-bg.png" alt="" />

          {spots.map((spot, i) => {
            const line = lines[i];
            if (!line) return <EmptyDesk key={`empty-${i}`} index={i} spot={spot} />;
            return (
              <Desk
                key={line.cp.id}
                line={line}
                index={i}
                spot={spot}
                briefing={briefing}
                heroMetric={heroMetric}
                onOpen={() => setOpenDesk(line.cp.id)}
              />
            );
          })}

          <div className="manager">
            <div className="cloud" data-tail="center">
              <span className="who">Manager</span>
              {managerSays(briefing, specText, s, winner ?? null)}
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/game/manager.png" alt="The manager at their desk" />
            <span className="px-plate plate">MANAGER</span>
          </div>
        </div>

        <div className="px-panel mission-bar">
          <span aria-hidden>🎯</span>
          <span className="query">
            {title} · <b>{specText}</b>
          </span>
          <button className="px-btn ghost" onClick={() => router.push("/")}>
            New mission
          </button>
        </div>
      </div>

      {openLine ? <TranscriptModal line={openLine} onClose={() => setOpenDesk(null)} /> : null}

      {s.ended && !resultsDismissed ? (
        <ResultsModal
          lines={lines}
          best={s.best}
          savings={s.savings}
          heroMetric={heroMetric}
          onClose={() => setResultsDismissed(true)}
          onNew={() => router.push("/")}
        />
      ) : null}

      {!s.connected && !s.ended ? <div className="px-panel toast">Reconnecting to the office…</div> : null}
    </div>
  );
}

/* ----------------------------------------------------------------- the desk */

function Desk({
  line,
  index,
  spot,
  briefing,
  heroMetric,
  onOpen,
}: {
  line: Line;
  index: number;
  spot: { left: number; top: number };
  briefing: boolean;
  heroMetric: string;
  onOpen: () => void;
}) {
  const sprite = WORKER_SPRITES[index % WORKER_SPRITES.length];
  const working = !line.ended && line.turns.length > 0;
  const stamp = line.ended ? outcomeStamp(line, heroMetric) : null;

  return (
    <div
      className="desk"
      style={{ left: `${spot.left}%`, top: `${spot.top}%` }}
      data-working={working}
      data-dead={line.dead}
      data-side={spot.left < 42 ? "left" : spot.left > 58 ? "right" : "center"}
    >
      {briefing && !line.ended ? (
        <span className="brief-pop" style={{ animationDelay: `${400 + index * 260}ms` }}>
          !
        </span>
      ) : null}

      {!briefing && !line.ended ? <DeskCloud line={line} /> : null}

      {line.value !== null && !line.ended ? (
        <span className="coin-pop" key={line.value}>
          {rupees(line.value)}
        </span>
      ) : null}

      {stamp ? (
        <span className="stamp" data-bad={stamp.bad}>
          {stamp.text}
        </span>
      ) : null}

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={sprite} alt={`Agent at desk ${index + 1}`} />
      <span className="px-plate plate">{shortName(line.cp.name)}</span>

      <button className="hit" onClick={onOpen} aria-label={`Open the call with ${line.cp.name}`} />
    </div>
  );
}

/** An unstaffed workstation. Same footprint as a live desk, nothing to say. */
function EmptyDesk({ index, spot }: { index: number; spot: { left: number; top: number } }) {
  return (
    <div className="desk" style={{ left: `${spot.left}%`, top: `${spot.top}%` }} data-empty="true">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/game/desk-empty.png" alt="" aria-hidden />
      <span className="px-plate plate">DESK {index + 1}</span>
    </div>
  );
}

function DeskCloud({ line }: { line: Line }) {
  if (!line.turns.length) {
    return (
      <div className="cloud" data-role="us">
        <span className="who">dialling</span>
        <span>
          ☎ ringing{" "}
          <span className="dots">
            <i />
            <i />
            <i />
          </span>
        </span>
      </div>
    );
  }

  const thinking = line.lastRole === "them";
  return (
    <div className="cloud" data-role={line.lastRole} key={`${line.turns.length}`}>
      <span className="who">{line.lastRole === "us" ? "Agent" : shortName(line.cp.name)}</span>
      {clip(line.lastText, 64)}
      {thinking ? (
        <span className="dots" style={{ marginLeft: 8 }}>
          <i />
          <i />
          <i />
        </span>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------- manager lines */

function managerSays(
  briefing: boolean,
  specText: string,
  s: { ended: boolean; best: { value: number } | null; savings: number | null },
  winner: Line | null
) {
  if (briefing) return <>Team! New mission: {specText}. Call around and get me the best price!</>;
  if (s.ended) {
    return s.best ? (
      <>
        Mission complete! {winner?.cp.name ?? "One of ours"} closed at <b>{rupees(s.best.value)}</b>.
      </>
    ) : (
      <>Mission complete. No deal today - we try more shops next round.</>
    );
  }
  return s.best ? (
    <>
      Best so far <b>{rupees(s.best.value)}</b>
      {winner ? <> from {shortName(winner.cp.name)}</> : null}. Keep pushing!
    </>
  ) : (
    <>The team is on the phones. Waiting for the first quote…</>
  );
}

/* ------------------------------------------------------------------ the log */

function LogFeed({
  lines,
  tape,
}: {
  lines: Line[];
  tape: { id: number; kind: string; text: string; value?: string; at?: number }[];
}) {
  const feed = useMemo(() => {
    const turns = lines.flatMap((l) =>
      l.turns.map((t, i) => ({
        key: `${l.cp.id}-t${i}`,
        at: t.at,
        kind: `turn-${t.role}`,
        who: t.role === "us" ? `Agent · ${shortName(l.cp.name)}` : shortName(l.cp.name),
        text: t.text,
        value: undefined as string | undefined,
      }))
    );
    const facts = tape.map((t) => ({
      key: `tape-${t.id}`,
      at: t.at ?? 0,
      kind: t.kind,
      who: "",
      text: t.text,
      value: t.value,
    }));
    return [...turns, ...facts].sort((a, b) => a.at - b.at).slice(-80);
  }, [lines, tape]);

  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [feed.length]);

  if (!feed.length) {
    return (
      <div className="log-feed">
        <div className="log-item">Waiting for the first call to connect…</div>
      </div>
    );
  }

  return (
    <div
      className="log-feed"
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {feed.map((f) => (
        <div className="log-item" data-kind={f.kind} key={f.key}>
          {f.who ? <span className="who">{f.who}</span> : null}
          {f.text} {f.value ? <b>{f.value}</b> : null}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------- modals */

function TranscriptModal({ line, onClose }: { line: Line; onClose: () => void }) {
  return (
    <div className="overlay" onClick={onClose} role="dialog" aria-label={`Call with ${line.cp.name}`}>
      <div className="px-panel modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3 className="modal-title">{line.cp.name}</h3>
          <button className="px-btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="transcript">
          {line.turns.length ? (
            line.turns.map((t, i) => (
              <div className="utter" data-role={t.role} key={`${t.at}-${i}`}>
                <span className="who">{t.role === "us" ? "Agent" : shortName(line.cp.name)}</span>
                {t.text}
                {t.latency_ms ? <span className="meta"> {(t.latency_ms / 1000).toFixed(1)}s</span> : null}
              </div>
            ))
          ) : (
            <div className="utter">The call has not connected yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function ResultsModal({
  lines,
  best,
  savings,
  heroMetric,
  onClose,
  onNew,
}: {
  lines: Line[];
  best: { value: number; cpId: string } | null;
  savings: number | null;
  heroMetric: string;
  onClose: () => void;
  onNew: () => void;
}) {
  const winner = lines.find((l) => l.cp.id === best?.cpId);
  const recordings = lines.filter((l) => l.recording);

  return (
    <div className="overlay" role="dialog" aria-label="Mission results">
      <div className="px-panel modal">
        <div className="results-banner">MISSION COMPLETE</div>

        <p className="winner-line">
          {winner ? (
            <>
              🏆 <b>{winner.cp.name}</b>
              {winner.cp.area ? <> · {winner.cp.area}</> : null} · {winner.cp.phone}
            </>
          ) : (
            <>No deal closed. Nobody gave a workable number - try more shops or widen the area.</>
          )}
        </p>

        <div className="results-grid">
          <div className="px-panel result-cell">
            <span className="v money">{best ? rupees(best.value) : "—"}</span>
            <span className="k">final {heroMetric.replace(/_/g, " ")}</span>
          </div>
          <div className="px-panel result-cell">
            <span className="v money">{savings ? rupees(savings) : "—"}</span>
            <span className="k">saved</span>
          </div>
          <div className="px-panel result-cell">
            <span className="v">{lines.filter((l) => !l.dead).length}</span>
            <span className="k">lines answered</span>
          </div>
        </div>

        {recordings.map((l) => (
          <a key={l.cp.id} className="recording-link" href={l.recording} target="_blank" rel="noreferrer">
            ▸ hear the call with {l.cp.name}
          </a>
        ))}

        <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
          <button className="px-btn" onClick={onNew}>
            New mission
          </button>
          <button className="px-btn ghost" onClick={onClose}>
            View the office
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ helpers */

/**
 * Anchor points, anchored to the FLOOR band of the background (the wall is the
 * top quarter). The office is drawn for four desks in two rows; more lines than
 * four fall back to an even spread so nothing ever overlaps.
 */
const FOUR_DESKS: { left: number; top: number }[] = [
  { left: 32, top: 62 },
  { left: 68, top: 62 },
  { left: 22, top: 88 },
  { left: 78, top: 88 },
];

function deskSpots(n: number): { left: number; top: number }[] {
  if (n <= 0) return [];
  if (n <= DESK_COUNT) return FOUR_DESKS.slice(0, Math.max(n, DESK_COUNT));
  const topRow = Math.ceil(n / 2);
  return [...spread(topRow, 62), ...spread(n - topRow, 88)];
}

function spread(k: number, top: number): { left: number; top: number }[] {
  if (k === 1) return [{ left: 50, top }];
  const span = Math.min(60, 28 * (k - 1));
  const start = 50 - span / 2;
  return Array.from({ length: k }, (_, i) => ({ left: start + (span * i) / (k - 1), top }));
}

function agentStatus(l: Line): string {
  if (l.dead) return "dead";
  if (l.ended) return "done";
  if (l.turns.length) return "live";
  return "idle";
}

function outcomeStamp(l: Line, heroMetric: string): { text: string; bad: boolean } | null {
  const price = l.value !== null ? rupees(l.value) : null;
  switch (l.outcome) {
    case "closed":
      return { text: price ? `CLOSED ${price}` : "CLOSED", bad: false };
    case "capped":
      return { text: price ? `CLOSED ${price}` : "TIME UP", bad: !price };
    case "no_answer":
      return { text: "NO ANSWER", bad: true };
    case "voicemail":
      return { text: "VOICEMAIL", bad: true };
    case "dead_lead":
      return { text: "DEAD LEAD", bad: true };
    case "duplicate":
      return { text: "DUPLICATE", bad: true };
    case "declined":
      return { text: "DECLINED", bad: true };
    case "opted_out":
      return { text: "OPTED OUT", bad: true };
    case "error":
      return { text: "LINE ERROR", bad: true };
    default:
      return l.ended ? { text: heroMetric && price ? `DONE ${price}` : "DONE", bad: false } : null;
  }
}

function summariseSpec(spec: Record<string, unknown>): string {
  return Object.entries(spec)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => (k === "budget_max" || /budget|target/.test(k) ? `budget ${rupees(Number(v))}` : String(v)))
    .join(" · ");
}

function shortName(name: string): string {
  if (name.length <= 16) return name;
  const cut = name.slice(0, 16);
  const space = cut.lastIndexOf(" ");
  return (space > 6 ? cut.slice(0, space) : cut) + "…";
}

function clip(text: string, n: number): string {
  return text.length <= n ? text : text.slice(0, n - 1) + "…";
}
