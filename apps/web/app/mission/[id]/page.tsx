"use client";

import { use, useEffect, useState } from "react";
import { Rail } from "@/components/Rail";
import { Board } from "@/components/Board";
import { API } from "@/lib/api";
import type { Column, Counterparty } from "@/lib/types";

type Snapshot = {
  mission: { id: string; skill_id: string; spec: Record<string, unknown> };
  skill: { id: string; label: string; emoji: string; ui: { mode: "ticker" | "table"; hero_metric: string }; columns: Column[] };
  bus: { cp: Counterparty }[];
};

export default function MissionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API}/missions/${id}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? "mission not found");
        return r.json();
      })
      .then(setSnap)
      .catch((e) => setError(e.message));
  }, [id]);

  if (error) {
    return (
      <>
        <Rail />
        <main className="shell">
          <div className="error" style={{ marginTop: 40 }}>{error}</div>
        </main>
      </>
    );
  }

  if (!snap) {
    return (
      <>
        <Rail />
        <main className="shell">
          <p className="mission-spec" style={{ marginTop: 40 }}>Opening the board…</p>
        </main>
      </>
    );
  }

  return (
    <>
      <Rail />
      <main className="shell">
        <Board
          missionId={id}
          counterparties={snap.bus.map((b) => b.cp)}
          heroMetric={snap.skill.ui.hero_metric}
          columns={snap.skill.columns}
          mode={snap.skill.ui.mode}
          title={`${snap.skill.emoji} ${snap.skill.label}`}
          spec={snap.mission.spec}
        />
      </main>
    </>
  );
}
