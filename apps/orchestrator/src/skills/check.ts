/**
 * `pnpm skills:check` - validate every skill file without booting the engine.
 * Wire this into CI (and run it before you touch the stage) so a malformed market
 * is caught at the terminal instead of on a live call.
 */
import { skills } from "./registry.js";
import { tableColumns, indexedFields } from "./schema.js";

const { loaded, errors } = skills.load();

for (const p of loaded) {
  const cols = tableColumns(p).map((c) => c.key).join(", ") || "(none)";
  console.log(
    `\n${p.emoji}  ${p.id.padEnd(12)} ${p.label}\n` +
      `   ui           ${p.ui.mode} · hero=${p.ui.hero_metric}\n` +
      `   negotiates   ${p.tactics.negotiable_fields.join(", ")} · anchor ${(p.tactics.anchor_pct * 100).toFixed(0)}% · ${p.tactics.max_rounds} rounds\n` +
      `   table cols   ${cols}\n` +
      `   indexed      ${indexedFields(p).join(", ") || "(none)"}\n` +
      `   voices       ${Object.entries(p.voices).map(([l, s]) => `${l}:${s}`).join(" ")} on ${p.tts.model}\n` +
      `   personas     ${p.eval_personas.length}`
  );
}

if (errors.length) {
  console.error(`\n${errors.length} skill file(s) rejected:`);
  for (const e of errors) console.error(`  ✗ ${e.file}\n    ${e.message}`);
  process.exit(1);
}

console.log(`\n✓ ${loaded.length} skill file(s) valid.\n`);
