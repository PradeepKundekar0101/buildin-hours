"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, rupees } from "@/lib/api";

/**
 * The standing counters. They are the first thing on screen and they are the
 * business case: real money, across more than one market, from real calls.
 */
export function Rail({ live }: { live?: number }) {
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.stats>> | null>(null);

  useEffect(() => {
    let alive = true;
    const pull = () => api.stats().then((s) => alive && setStats(s)).catch(() => undefined);
    pull();
    const t = setInterval(pull, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <header className="rail">
      <Link href="/" className="wordmark">
        Mol<span>Bhav</span>
      </Link>

      {live ? (
        <span className="stat-label">
          <span className="live-dot" />
          {live} {live === 1 ? "line" : "lines"} open
        </span>
      ) : null}

      <div className="rail-stats">
        <Stat value={rupees(stats?.saved ?? 0)} label="saved" />
        <Stat value={String(stats?.calls ?? 0)} label="calls placed" />
        <Stat value={String(stats?.missions ?? 0)} label="missions" />
        <Stat value={String(stats?.skills_installed ?? 0)} label="markets installed" />
      </div>
    </header>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}
