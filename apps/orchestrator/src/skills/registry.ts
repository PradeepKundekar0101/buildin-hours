import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SkillPackSchema, type SkillPack } from "./schema.js";
import { log } from "../log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** packages/skills relative to apps/orchestrator/src/skills */
export const SKILLS_DIR = resolve(__dirname, "../../../../packages/skills");

export type LoadResult = {
  loaded: SkillPack[];
  errors: { file: string; message: string }[];
};

class SkillRegistry {
  private packs = new Map<string, SkillPack>();
  private lastErrors: LoadResult["errors"] = [];

  /**
   * Read every *.skill.json and validate. A bad pack is skipped with a loud error
   * rather than crashing the engine - one broken market must not take the bazaar down.
   */
  load(): LoadResult {
    const errors: LoadResult["errors"] = [];
    const loaded: SkillPack[] = [];

    if (!existsSync(SKILLS_DIR)) {
      throw new Error(`skills directory not found at ${SKILLS_DIR}`);
    }

    const files = readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".skill.json"));

    for (const file of files) {
      const path = join(SKILLS_DIR, file);
      try {
        const raw = JSON.parse(readFileSync(path, "utf8"));
        const parsed = SkillPackSchema.safeParse(raw);
        if (!parsed.success) {
          const message = parsed.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ");
          errors.push({ file, message });
          log.error(`skill ${file} rejected -> ${message}`);
          continue;
        }
        loaded.push(parsed.data);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ file, message });
        log.error(`skill ${file} unreadable -> ${message}`);
      }
    }

    // Swap in atomically so a reload never leaves the registry half-empty.
    const next = new Map<string, SkillPack>();
    for (const p of loaded) next.set(p.id, p);
    this.packs = next;
    this.lastErrors = errors;

    log.info(
      `skills loaded: ${loaded.map((p) => `${p.emoji} ${p.id}`).join(", ") || "(none)"}` +
        (errors.length ? ` | ${errors.length} rejected` : "")
    );
    return { loaded, errors };
  }

  all(): SkillPack[] {
    return [...this.packs.values()];
  }

  get(id: string): SkillPack | undefined {
    return this.packs.get(id);
  }

  require(id: string): SkillPack {
    const p = this.packs.get(id);
    if (!p) throw new Error(`unknown skill "${id}". Loaded: ${[...this.packs.keys()].join(", ")}`);
    return p;
  }

  errors() {
    return this.lastErrors;
  }

  /** Compact form handed to the classifier prompt and to the web composer. */
  catalog() {
    return this.all().map((p) => ({
      id: p.id,
      label: p.label,
      emoji: p.emoji,
      ui: p.ui,
      paste_hint: p.discovery.paste_hint,
      mission_fields: p.mission_fields,
    }));
  }
}

export const skills = new SkillRegistry();
