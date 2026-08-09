"use client";

import { use, useEffect, useState } from "react";
import { Office } from "@/components/Office";
import { API } from "@/lib/api";
import type { Column, Counterparty } from "@/lib/types";

type Snapshot = {
  mission: { id: string; skill_id: string; spec: Record<string, unknown> };
  skill: {
    id: string;
    label: string;
    emoji: string;
    ui: { mode: "ticker" | "table"; hero_metric: string };
    columns: Column[];
  };
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
      <main className="title-screen">
        <div className="px-panel error-box" style={{ marginTop: 60 }}>
          {error}
        </div>
      </main>
    );
  }

  if (!snap) {
    return (
      <main className="title-screen">
        <div className="px-panel toast" style={{ position: "static", transform: "none", marginTop: 60 }}>
          Opening the office…
        </div>
      </main>
    );
  }

  return (
    <Office
      missionId={id}
      counterparties={snap.bus.map((b) => b.cp)}
      heroMetric={snap.skill.ui.hero_metric}
      title={`${snap.skill.emoji} ${snap.skill.label}`}
      spec={snap.mission.spec}
    />
  );
}
