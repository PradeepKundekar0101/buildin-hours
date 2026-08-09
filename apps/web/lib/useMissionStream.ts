"use client";

import { useEffect, useRef, useState } from "react";
import { API } from "./api";
import type { Counterparty, Line, MissionEvent } from "./types";

/**
 * Folds the orchestrator's event stream into the board's state.
 *
 * The stream replays from the start on connect, so a browser opened mid-mission
 * still sees the whole story - which matters when a judge picks up a phone halfway
 * through a run.
 */

export type Arc = { id: number; fromCpId: string; toCpId: string; label: string };

export type MissionState = {
  lines: Map<string, Line>;
  order: string[];
  tape: { id: number; kind: string; text: string; value?: string }[];
  arcs: Arc[];
  best: { value: number; cpId: string } | null;
  firstMax: number | null;
  ended: boolean;
  savings: number | null;
  heroMetric: string;
  connected: boolean;
  test: boolean;
  testRedirect: string | null;
};

const EMPTY: MissionState = {
  lines: new Map(),
  order: [],
  tape: [],
  arcs: [],
  best: null,
  firstMax: null,
  ended: false,
  savings: null,
  heroMetric: "price",
  connected: false,
  test: false,
  testRedirect: null,
};

export function useMissionStream(missionId: string | null, heroMetric: string, counterparties: Counterparty[]) {
  const [state, setState] = useState<MissionState>({ ...EMPTY, heroMetric });
  const seq = useRef(0);

  useEffect(() => {
    if (!missionId) return;

    const lines = new Map<string, Line>();
    for (const cp of counterparties) {
      lines.set(cp.id, {
        cp,
        state: "DIAL",
        facts: {},
        value: null,
        first: null,
        turns: [],
        lastText: "",
        lastRole: "us",
        lang: cp.lang_hint,
        dead: false,
        ended: false,
        freshFields: new Set(),
      });
    }
    setState({ ...EMPTY, heroMetric, lines, order: counterparties.map((c) => c.id), connected: false });

    const source = new EventSource(`${API}/missions/${missionId}/events`);
    source.onopen = () => setState((s) => ({ ...s, connected: true }));

    source.onmessage = (msg) => {
      let event: MissionEvent;
      try {
        event = JSON.parse(msg.data);
      } catch {
        return;
      }
      setState((prev) => reduce(prev, event, ++seq.current));
    };

    source.onerror = () => setState((s) => ({ ...s, connected: false }));

    return () => source.close();
    // counterparties is a stable array handed in once with the mission.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missionId, heroMetric]);

  return state;
}

function reduce(prev: MissionState, e: MissionEvent, id: number): MissionState {
  let test = prev.test;
  let testRedirect = prev.testRedirect;
  const lines = new Map(prev.lines);
  const order = [...prev.order];
  let tape = prev.tape;
  let arcs = prev.arcs;
  let best = prev.best;
  let firstMax = prev.firstMax;
  let ended = prev.ended;
  let savings = prev.savings;

  const cpId = String(e.cp_id ?? "");

  const touch = (id: string): Line | null => {
    const line = lines.get(id);
    if (!line) return null;
    const next = { ...line, freshFields: new Set(line.freshFields) };
    lines.set(id, next);
    return next;
  };

  switch (e.type) {
    case "mission.start": {
      if (e.test) {
        test = true;
        testRedirect = (e.test_redirect as string) ?? null;
      }
      const cps = (e.counterparties as Counterparty[]) ?? [];
      for (const cp of cps) {
        if (!lines.has(cp.id)) {
          lines.set(cp.id, {
            cp,
            state: "DIAL",
            facts: {},
            value: null,
            first: null,
            turns: [],
            lastText: "",
            lastRole: "us",
            lang: cp.lang_hint,
            dead: false,
            ended: false,
            freshFields: new Set(),
          });
          order.push(cp.id);
        }
      }
      break;
    }

    case "turn": {
      const line = touch(cpId);
      if (line) {
        const role = e.role === "them" ? "them" : "us";
        const text = String(e.text ?? "");
        line.lastText = text;
        line.lastRole = role;
        if (e.lang) line.lang = String(e.lang);
        line.turns = [
          ...line.turns,
          {
            at: Number(e.at ?? Date.now()),
            role,
            text,
            lang: e.lang ? String(e.lang) : undefined,
            latency_ms: typeof e.latency_ms === "number" ? e.latency_ms : undefined,
          },
        ];
      }
      break;
    }

    case "call.state": {
      const line = touch(cpId);
      if (line) line.state = String(e.state ?? line.state);
      break;
    }

    case "fact.cell": {
      const line = touch(cpId);
      const facts = (e.facts as Record<string, unknown>) ?? {};
      if (line) {
        line.facts = { ...line.facts, ...facts };
        line.freshFields = new Set(Object.keys(facts));
        // The hero metric is what the room is watching; print it first and mark it.
        const entries = Object.entries(facts).sort(([a], [b]) =>
          a === prev.heroMetric ? -1 : b === prev.heroMetric ? 1 : 0
        );
        tape = [
          ...tape,
          ...entries.map(([k, v], n) => ({
            id: id * 100 + n,
            kind: k === prev.heroMetric ? "quote" : "fact",
            text: `${short(line.cp.name)} · ${k.replace(/_/g, " ")}`,
            value: k === prev.heroMetric && typeof v === "number" ? fmt(v) : String(v),
          })),
        ].slice(-40);
      }
      break;
    }

    case "ticker": {
      const line = touch(cpId);
      const value = Number(e.value);
      if (line && Number.isFinite(value)) {
        if (line.first === null) {
          line.first = value;
          firstMax = firstMax === null ? value : Math.max(firstMax, value);
        }
        // A number that moved down on an open line is the whole point of the board.
        const movedDown = line.value !== null && value < line.value;
        line.value = value;
        if (movedDown && best) {
          arcs = [...arcs, { id, fromCpId: best.cpId, toCpId: cpId, label: fmt(best.value) }].slice(-3);
        }
        if (!best || value < best.value) best = { value, cpId };
      }
      break;
    }

    case "dead_lead": {
      const line = touch(cpId);
      if (line) line.dead = true;
      tape = [...tape, { id, kind: "dead", text: `${line?.cp.name ?? "line"} · no facts`, value: "dead lead" }].slice(-40);
      break;
    }

    case "dedup": {
      const line = touch(cpId);
      if (line) {
        line.dead = true;
        line.outcome = "duplicate";
      }
      tape = [...tape, { id, kind: "dedup", text: `${line?.cp.name ?? "line"}`, value: "same outfit, skipped" }].slice(-40);
      break;
    }

    case "call.end": {
      const line = touch(cpId);
      if (line) {
        line.ended = true;
        line.state = "DONE";
        line.outcome = String(e.outcome ?? "");
        if (e.recording_url) line.recording = String(e.recording_url);
      }
      break;
    }

    case "mission.end": {
      ended = true;
      savings = e.savings === null || e.savings === undefined ? null : Number(e.savings);
      break;
    }
  }

  return { ...prev, lines, order, tape, arcs, best, firstMax, ended, savings, test, testRedirect };
}

function fmt(n: number): string {
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

/** Names on the tape have to fit; trim on a word boundary, never mid-word. */
function short(name: string): string {
  if (name.length <= 20) return name;
  const cut = name.slice(0, 20);
  const space = cut.lastIndexOf(" ");
  return (space > 8 ? cut.slice(0, space) : cut) + "…";
}
