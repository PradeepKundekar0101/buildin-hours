import { Router } from "express";
import { randomUUID } from "node:crypto";
import { skills } from "../skills/registry.js";
import { tableColumns } from "../skills/schema.js";
import { classifierPrompt } from "../engine/prompts.js";
import { chat, latencyP95 } from "../sarvam/chat.js";
import { discover, extractPhones } from "../discovery/index.js";
import { startMission, getRun, allRuns } from "../engine/mission.js";
import { bus } from "../events.js";
import { publicStats, bhavIndex } from "../db/repo.js";
import { liveTwilioTransports } from "../transports/twilio.js";
import { addOptOut, isOptedOut, withinCallWindow, callWindowMessage } from "../policy.js";
import { env, has, bootReport } from "../env.js";
import { log } from "../log.js";

export const api = Router();

api.get("/health", (_req, res) => {
  res.json({
    ok: true,
    skills: skills.all().length,
    config: bootReport(),
    turn_p95_ms: latencyP95(),
    twilio: has.twilio(),
    // The composer needs to show which number a test run would actually ring.
    test_number: env.testCallRedirect || null,
    test_default: env.testModeDefault,
  });
});

/** Everything the web app needs to render any market without per-market code. */
api.get("/skills", (_req, res) => {
  res.json({
    skills: skills.all().map((p) => ({
      id: p.id,
      label: p.label,
      emoji: p.emoji,
      ui: p.ui,
      mission_fields: p.mission_fields,
      paste_hint: p.discovery.paste_hint,
      share_copy: p.share_copy,
      columns: tableColumns(p),
      hero_metric: p.ui.hero_metric,
      counterparty_kinds: p.counterparty_kinds,
    })),
    errors: skills.errors(),
  });
});

/** The live-add beat: drop a .skill.json on disk, hit this, a new market exists. */
api.post("/admin/skills/reload", (_req, res) => {
  const result = skills.load();
  for (const p of result.loaded) {
    bus.emit("global", { type: "skill.loaded", id: p.id, label: p.label, emoji: p.emoji });
  }
  res.json({
    loaded: result.loaded.map((p) => ({ id: p.id, label: p.label, emoji: p.emoji })),
    errors: result.errors,
  });
});

/** Free text in, skill + mission fields out. */
api.post("/compose", async (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) return res.status(400).json({ error: "text is required" });

  try {
    const { value } = await chat<{
      skill_id: string;
      confidence: number;
      spec: Record<string, string | number>;
      pasted?: { phones?: string[] };
    }>({
      label: "classify",
      temperature: 0.1,
      maxTokens: 400,
      messages: [
        { role: "system", content: classifierPrompt(skills.catalog()) },
        { role: "user", content: text },
      ],
      json: {
        name: "mission_classification",
        primaryKey: "skill_id",
        shape:
          "{\n" +
          `  "skill_id": "one of: ${skills.all().map((s) => s.id).join(" | ")} | ask",\n` +
          '  "confidence": 0.0 to 1.0,\n' +
          '  "spec": { "<mission_field key>": "value" },\n' +
          '  "pasted": { "phones": ["+91XXXXXXXXXX"] }\n' +
          "}",
      },
    });

    // Trust the regex over the model for phone numbers.
    const phones = [...new Set([...(value.pasted?.phones ?? []), ...extractPhones(text)])];
    const known = skills.get(value.skill_id);

    res.json({
      skill_id: known ? value.skill_id : "ask",
      confidence: value.confidence,
      spec: value.spec ?? {},
      phones,
      // Low confidence: hand the user three chips instead of guessing.
      options: known && value.confidence >= 0.7 ? [] : skills.catalog().slice(0, 3),
    });
  } catch (err) {
    log.error(`compose failed: ${err instanceof Error ? err.message : err}`);
    res.status(502).json({ error: "classification failed", detail: String(err) });
  }
});

/** Preview who we would call, before committing to dial anyone. */
api.post("/discover", async (req, res) => {
  const pack = skills.get(String(req.body?.skill_id ?? ""));
  if (!pack) return res.status(400).json({ error: "unknown skill_id" });

  const counterparties = await discover({
    pack,
    spec: req.body?.spec ?? {},
    pastedPhones: req.body?.phones ?? [],
    limit: Number(req.body?.limit ?? env.maxParallelCalls),
  });
  res.json({ counterparties });
});

api.post("/missions", async (req, res) => {
  const pack = skills.get(String(req.body?.skill_id ?? ""));
  if (!pack) return res.status(400).json({ error: "unknown skill_id" });

  const mode: "pstn" | "sim" = req.body?.mode === "sim" ? "sim" : has.twilio() ? "pstn" : "sim";

  // Test mode: real telephony, redirected to one number you answer yourself.
  const wantsTest = req.body?.test === undefined ? env.testModeDefault : Boolean(req.body.test);
  const redirect = String(req.body?.test_number ?? env.testCallRedirect ?? "").trim();
  if (wantsTest && mode === "pstn" && !/^\+[1-9]\d{7,14}$/.test(redirect)) {
    return res.status(400).json({
      error: redirect
        ? `test_number "${redirect}" is not E.164 (expected +919876543210)`
        : "test mode needs a number to ring - set TEST_CALL_REDIRECT or pass test_number",
    });
  }
  const testRedirect = wantsTest && mode === "pstn" ? redirect : undefined;

  // A redirected call never reaches a shop, so the calling window does not apply.
  if (mode === "pstn" && !testRedirect && !withinCallWindow()) {
    return res.status(409).json({ error: callWindowMessage() });
  }

  const missing = pack.mission_fields
    .filter((f) => f.required && (req.body?.spec ?? {})[f.key] === undefined)
    .map((f) => f.key);
  if (missing.length) {
    return res.status(400).json({ error: `missing required fields: ${missing.join(", ")}`, missing });
  }

  let counterparties = await discover({
    pack,
    spec: req.body.spec,
    pastedPhones: req.body?.phones ?? [],
    limit: Number(req.body?.limit ?? env.maxParallelCalls),
  });

  counterparties = counterparties.filter((c) => !isOptedOut(c.phone));
  if (!counterparties.length) {
    return res.status(404).json({ error: "no counterparties found - paste some numbers or add a seed CSV row" });
  }

  // In test mode every call rings the same phone, so ringing the whole roster just
  // means answering the same conversation five times over.
  if (testRedirect) {
    const wanted = Math.max(1, Number(req.body?.test_calls ?? env.testCallCount));
    if (counterparties.length > wanted) {
      log.info(`test mode: ringing ${wanted} of ${counterparties.length} counterparties`);
      counterparties = counterparties.slice(0, wanted);
    }
  }

  const run = await startMission({
    pack,
    spec: req.body.spec,
    counterparties,
    userId: String(req.body?.user_id ?? "anon"),
    userPhone: req.body?.user_phone,
    firstName: req.body?.first_name,
    mode,
    testRedirect,
  });

  res.json({
    mission_id: run.mission.id,
    skill: { id: pack.id, label: pack.label, emoji: pack.emoji, ui: pack.ui, columns: tableColumns(pack) },
    mode,
    test: Boolean(testRedirect),
    // Echoed back so it is impossible to run a test thinking it was real, or the reverse.
    test_redirect: testRedirect ?? null,
    counterparties: counterparties.map((c) => ({
      ...c,
      dialing: testRedirect ?? c.phone,
    })),
  });
});

/** Live theater feed. */
api.get("/missions/:id/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  const unsubscribe = bus.subscribe(req.params.id, send);
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);

  req.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
});

api.get("/missions/:id", async (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "unknown mission" });

  res.json({
    mission: run.mission,
    skill: { id: run.pack.id, label: run.pack.label, emoji: run.pack.emoji, ui: run.pack.ui, columns: tableColumns(run.pack) },
    calls: [...run.calls.values()],
    bus: run.bus.all().map((e) => ({
      cp: e.cp,
      facts: e.facts,
      first: e.first,
      latest: e.latest,
      dead: e.dead,
    })),
    events: bus.replay(req.params.id),
  });
});

api.get("/missions", (_req, res) => {
  res.json({
    missions: allRuns().map((r) => ({
      id: r.mission.id,
      skill_id: r.mission.skill_id,
      status: r.mission.status,
      spec: r.mission.spec,
      calls: r.calls.size,
    })),
  });
});

api.get("/stats", async (_req, res) => {
  res.json({ ...(await publicStats()), turn_p95_ms: latencyP95(), skills_installed: skills.all().length });
});

api.get("/index", async (req, res) => {
  res.json({ rows: await bhavIndex(req.query.skill ? String(req.query.skill) : undefined) });
});

api.post("/optout", (req, res) => {
  const phone = String(req.body?.phone ?? "");
  if (!phone) return res.status(400).json({ error: "phone is required" });
  addOptOut(phone);
  log.info(`opt-out recorded for ${phone}`);
  res.json({ ok: true });
});

// ---- Twilio webhooks ----

api.post("/twilio/status/:callId", (req, res) => {
  liveTwilioTransports.get(req.params.callId)?.notifyStatus(String(req.body?.CallStatus ?? ""));
  res.sendStatus(204);
});

api.post("/twilio/amd/:callId", (req, res) => {
  const answeredBy = String(req.body?.AnsweredBy ?? "");
  if (answeredBy.startsWith("machine") || answeredBy === "fax") {
    liveTwilioTransports.get(req.params.callId)?.notifyVoicemail();
  }
  res.sendStatus(204);
});

api.post("/twilio/recording/:callId", (req, res) => {
  const url = String(req.body?.RecordingUrl ?? "");
  if (url) liveTwilioTransports.get(req.params.callId)?.notifyRecording(`${url}.mp3`);
  res.sendStatus(204);
});

/** Demo driver: run a scripted mission on the simulator with one click. */
api.post("/demo/:skillId", async (req, res) => {
  const pack = skills.get(req.params.skillId);
  if (!pack) return res.status(404).json({ error: "unknown skill" });

  const spec: Record<string, string | number> = {};
  for (const f of pack.mission_fields) {
    if (req.body?.spec?.[f.key] !== undefined) spec[f.key] = req.body.spec[f.key];
    else if (f.default !== undefined) spec[f.key] = f.default;
    else if (f.required) spec[f.key] = demoValue(f.key, f.type);
  }

  const counterparties = Array.from({ length: Math.min(4, env.maxParallelCalls) }, (_, i) => ({
    id: randomUUID(),
    name: `${pack.label} ${String.fromCharCode(65 + i)}`,
    phone: `+9190000000${10 + i}`,
    kind: pack.counterparty_kinds[0],
    area: String(spec.area ?? "Koramangala"),
    city: String(spec.city ?? "Bengaluru"),
    source: "seed" as const,
    attrs: {},
    lang_hint: ["hi-IN", "en-IN", "kn-IN", "en-IN"][i],
  }));

  const run = await startMission({
    pack,
    spec,
    counterparties,
    userId: "demo",
    firstName: "Pradeep",
    mode: "sim",
  });

  res.json({ mission_id: run.mission.id, mode: "sim", counterparties });
});

/** Plausible stand-ins so a one-click demo never shows the word "demo" on screen. */
function demoValue(key: string, type: string): string | number {
  const named: Record<string, string | number> = {
    area: "Koramangala",
    city: "Bengaluru",
    from_area: "HSR Layout",
    to_area: "Whitefield",
    item: "iPhone 15 128GB",
    gig: "logo and brand kit",
    item_spec: "ABS enclosure, 120x80mm",
    home_size: "2BHK",
    quantity: 5000,
    budget_max: 60000,
    target_unit_price: 42,
  };
  if (named[key] !== undefined) return named[key];
  if (type === "int") return 30000;
  if (type === "date") return "this Friday";
  return "as discussed";
}
