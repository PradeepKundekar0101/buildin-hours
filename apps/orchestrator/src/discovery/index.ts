import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SKILLS_DIR } from "../skills/registry.js";
import type { SkillPack } from "../skills/schema.js";
import type { Counterparty } from "../engine/types.js";
import { env, has } from "../env.js";
import { log } from "../log.js";

/**
 * Three sources, one list. Pasted numbers win (the user knows their own market),
 * then the seed CSV (curated, verified), then Places (breadth).
 *
 * Every query template lives in the skill file, so adding a market adds its own
 * discovery without an engine change.
 */

export async function discover(args: {
  pack: SkillPack;
  spec: Record<string, string | number>;
  pastedPhones?: string[];
  limit?: number;
}): Promise<Counterparty[]> {
  const { pack, spec } = args;
  const limit = args.limit ?? env.maxParallelCalls;
  const out: Counterparty[] = [];
  const seen = new Set<string>();

  const push = (cp: Counterparty) => {
    const key = normalisePhone(cp.phone);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(cp);
  };

  for (const phone of args.pastedPhones ?? []) {
    push({
      id: randomUUID(),
      name: "Pasted number",
      phone: normalisePhone(phone),
      kind: pack.counterparty_kinds[0],
      area: String(spec.area ?? ""),
      city: String(spec.city ?? "Bengaluru"),
      source: "pasted",
      attrs: {},
    });
  }

  for (const cp of readSeed(pack)) {
    if (out.length >= limit) break;
    push(cp);
  }

  if (out.length < limit && has.places()) {
    try {
      for (const cp of await fromPlaces(pack, spec, limit - out.length)) push(cp);
    } catch (err) {
      log.warn(`places lookup failed, continuing with seed + pasted: ${err instanceof Error ? err.message : err}`);
    }
  }

  return out.slice(0, limit);
}

function readSeed(pack: SkillPack): Counterparty[] {
  if (!pack.discovery.seed_csv) return [];
  const path = join(SKILLS_DIR, pack.discovery.seed_csv);
  if (!existsSync(path)) return [];

  const lines = readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (lines.length < 2) return [];

  const header = lines[0].split(",").map((h) => h.trim());
  const rows: Counterparty[] = [];

  for (const line of lines.slice(1)) {
    const cells = splitCsv(line);
    const rec: Record<string, string> = {};
    header.forEach((h, i) => (rec[h] = (cells[i] ?? "").trim()));
    if (!rec.phone) continue;

    const { name, phone, area, city, kind, lang_hint, notes, ...attrs } = rec;
    rows.push({
      id: randomUUID(),
      name: name || "Unnamed",
      phone: normalisePhone(phone),
      kind: kind || pack.counterparty_kinds[0],
      area,
      city,
      source: "seed",
      lang_hint: lang_hint || undefined,
      attrs: Object.fromEntries(Object.entries(attrs).filter(([, v]) => v)),
    });
  }
  return rows;
}

async function fromPlaces(
  pack: SkillPack,
  spec: Record<string, string | number>,
  want: number
): Promise<Counterparty[]> {
  const area = String(spec.area ?? "");
  const city = String(spec.city ?? "Bengaluru");
  const results: Counterparty[] = [];

  for (const template of pack.discovery.places_queries) {
    if (results.length >= want) break;

    const query = template.replace(/\{(\w+)\}/g, (_, k: string) =>
      String(k === "area" ? area : k === "city" ? city : spec[k] ?? "")
    );

    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": env.placesKey,
        "X-Goog-FieldMask":
          "places.displayName,places.nationalPhoneNumber,places.internationalPhoneNumber,places.rating,places.userRatingCount,places.shortFormattedAddress",
      },
      body: JSON.stringify({ textQuery: query, regionCode: "IN", maxResultCount: 20 }),
    });

    if (!res.ok) throw new Error(`Places ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const data = (await res.json()) as {
      places?: {
        displayName?: { text?: string };
        internationalPhoneNumber?: string;
        nationalPhoneNumber?: string;
        rating?: number;
        userRatingCount?: number;
        shortFormattedAddress?: string;
      }[];
    };

    const scored = (data.places ?? [])
      .filter((p) => p.internationalPhoneNumber || p.nationalPhoneNumber)
      // Rating alone rewards a single 5-star review; weight by log(reviews).
      .map((p) => ({ p, score: (p.rating ?? 3) * Math.log1p(p.userRatingCount ?? 0) }))
      .sort((a, b) => b.score - a.score);

    for (const { p } of scored) {
      results.push({
        id: randomUUID(),
        name: p.displayName?.text ?? "Unnamed",
        phone: normalisePhone(p.internationalPhoneNumber ?? p.nationalPhoneNumber ?? ""),
        kind: pack.counterparty_kinds[0],
        area,
        city,
        source: "places",
        attrs: { address: p.shortFormattedAddress ?? "" },
      });
      if (results.length >= want) break;
    }
  }
  return results;
}

/** CSV split that tolerates quoted cells containing commas. */
function splitCsv(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      cells.push(cur);
      cur = "";
    } else cur += c;
  }
  cells.push(cur);
  return cells;
}

export function normalisePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  return digits ? `+${digits.replace(/^0+/, "")}` : "";
}

/** Pull phone numbers out of a blob the user pasted. */
export function extractPhones(text: string): string[] {
  const matches = text.match(/(\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}/g) ?? [];
  return [...new Set(matches.map(normalisePhone))].filter(Boolean);
}
