export const API = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8080";

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

export const api = {
  skills: () => json<{ skills: import("./types").Skill[] }>("/skills"),

  compose: (text: string) =>
    json<{
      skill_id: string;
      confidence: number;
      spec: Record<string, string | number>;
      phones: string[];
      options: { id: string; label: string; emoji: string }[];
    }>("/compose", { method: "POST", body: JSON.stringify({ text }) }),

  startMission: (body: {
    skill_id: string;
    spec: Record<string, string | number>;
    phones?: string[];
    mode?: "pstn" | "sim";
    first_name?: string;
  }) =>
    json<{
      mission_id: string;
      mode: string;
      skill: { id: string; label: string; emoji: string; ui: { mode: string; hero_metric: string }; columns: import("./types").Column[] };
      counterparties: import("./types").Counterparty[];
    }>("/missions", { method: "POST", body: JSON.stringify(body) }),

  demo: (skillId: string) =>
    json<{ mission_id: string; mode: string; counterparties: import("./types").Counterparty[] }>(
      `/demo/${skillId}`,
      { method: "POST", body: JSON.stringify({}) }
    ),

  stats: () =>
    json<{
      users: number;
      missions: number;
      calls: number;
      saved: number;
      dead_leads: number;
      skills_installed: number;
      turn_p95_ms: number | null;
      by_skill: Record<string, { missions: number; saved: number }>;
    }>("/stats"),

  reloadSkills: () =>
    json<{ loaded: { id: string; label: string; emoji: string }[]; errors: { file: string; message: string }[] }>(
      "/admin/skills/reload",
      { method: "POST", body: "{}" }
    ),
};

export function rupees(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}
