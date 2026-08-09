# MolBhav v3

**The negotiation engine for every bazaar.**
One engine phones India's offline markets in their own languages.
Every market - electronics, freelancers, movers, factory RFQs - is a declarative skill file, not a feature.

---

## Run it

```bash
pnpm install
cp .env.example .env    # fill in SARVAM_API_KEY at minimum
```

Two processes:

```bash
pnpm dev:api
```

```bash
pnpm dev:web
```

The orchestrator prints exactly which integrations are live at boot, so a missing key is obvious before the demo rather than during it.

### No keys yet?

```bash
MOCK_SARVAM=1 pnpm dev:api
```

Mock mode swaps in a deterministic stand-in for STT, TTS, and the negotiation brain.
The whole board runs - state machine, fact bus, leverage, savings math, live theater - without a single API call.
This is for building the UI and for CI, never a runtime fallback: if the key is missing in production the engine says so loudly instead of quietly faking a negotiation.

### Real phone calls

Twilio needs to reach this machine, so the orchestrator must be on a public HTTPS URL.

```bash
ngrok http 8080
```

Put that URL in `PUBLIC_BASE_URL`. Twilio then opens a media stream back to `wss://<that host>/media/:callId`.

---

## What is verified, and what is not

Checked against the official SDK (`sarvamai@1.1.8`), not from documentation:

| Question | Answer | Consequence |
|---|---|---|
| Does TTS emit 8 kHz? | Yes, `speech_sample_rate: 8000` | No downsampling |
| Can STT take Twilio's wire format? | Yes - `speechToTextRealtimeStreaming` accepts `encoding: "mulaw"`, `sample_rate: "8000"` | **No transcode layer anywhere.** Twilio frames go straight into Sarvam and Bulbul's mulaw comes straight back out |
| Server-side turn detection? | Yes - `endpointing: "vad"`, plus `silence_duration_ms`, `threshold`, `prefix_padding_ms` | Nothing in this codebase counts silence |
| Language detection? | `language_code: "auto"` returns `language` on every final transcript | Voice selection is free |
| Which speakers exist? | `bulbul:v2` has **7**; `bulbul:v3` has **37** | See below |
| Guaranteed JSON? | `response_format: { type: "json_schema" }` | The turn contract is enforced by the API, not begged for in a prompt |

**The speaker trap.** The original spec's skill files named `kavitha`, `pooja`, `amit`, `gokul`, and `shreya` on `bulbul:v2`. Those voices do not exist on v2 - they are v3-only, and the failure surfaces at synthesis time, which is to say live, mid-call. Every pack now runs on `bulbul:v3`, and the loader rejects any pack whose speaker is not on its model's roster.

Still unverified (needs the venue network and a real key): rate limits and concurrency on hackathon credits, and measured `sarvam-105b` turn latency against the budget.

---

## Adding a market

1. Write `packages/skills/<id>.skill.json`
2. Add a seed CSV of real, publicly listed numbers
3. `pnpm skills:check` - the loader validates cross-field consistency, not just shape
4. `pnpm eval --skill <id>` - gate is 7/10 personas
5. `POST /admin/skills/reload` - the market is live

If any of that required editing `apps/orchestrator/src/engine/`, the abstraction is wrong. Fix the skill, not the engine.

```bash
pnpm skills:check
```

```bash
MOCK_SARVAM=1 pnpm eval --seeds 2 --mock
```

---

## How it fits together

```
Next.js theater  ──SSE──►  Orchestrator  ──►  Twilio Media Streams  ──►  PSTN
  (schema-driven)              │                  mulaw 8k both ways
                               ├── SkillPack registry (hot-reloadable)
                               ├── Fact Bus ─── leverage · dedup · dead-lead
                               ├── Negotiation core (transport-agnostic)
                               └── Sarvam: realtime STT → chat → Bulbul
                                          │
                                     Supabase (missions, calls, index)
```

**The seam that matters** is `engine/transport.ts`. A PSTN call and a simulated counterparty implement the same three verbs, so the eval harness exercises the exact code that runs on stage - and when venue telephony wobbles, the demo falls back to the simulator without the engine noticing.

**The Fact Bus** is why six parallel calls beat six sequential ones. Facts publish the instant they are learned, so a quote from line 3 is leverage on line 1 while both are still open. Leverage lines may only ever quote numbers that actually arrived on the bus - enforced in `fact-bus.ts`, restated in the prompt, and checked by the eval harness.

### Deliberate departures from the spec

- **SSE instead of Supabase Realtime for the theater.** The events originate in the orchestrator; routing them through the database and back adds a hop, a schema, and a failure mode on the one surface judges actually watch. Supabase still stores everything for counters and the index.
- **`bulbul:v3` over `v2`.** v3 has the voices the skill files need plus `dict_id` for SKU pronunciation. It loses Sarvam's beta response cache, so fillers are cached in-process instead - which is faster anyway.
- **Structured outputs over prompt-and-hope.** "JSON validity 100%" stops being an eval gate and becomes a property of the transport.

---

## Repo map

```
packages/skills/         the markets. 4 shipped, ~60 lines each
apps/orchestrator/
  src/skills/            zod schema + hot-reloading registry
  src/sarvam/            STT, TTS, chat, and the mock
  src/engine/            negotiation core, fact bus, formula evaluator, transports
  src/transports/        twilio.ts (PSTN) and sim.ts (simulated counterparty)
  src/discovery/         pasted numbers > seed CSV > Google Places
  src/eval/              persona harness and gates
  sql/schema.sql         run once in Supabase
apps/web/                the board
```

---

## Before dialling anyone

Seed CSVs ship with deliberately invalid `+9190000000xx` numbers so an accidental run cannot reach a stranger. Replace them with numbers that are publicly listed for business contact.

The engine refuses to dial outside 09:00-20:30 IST (`IGNORE_CALL_WINDOW=1` for rehearsal), checks an opt-out list before every call, and answers honestly the moment anyone asks whether they are talking to a machine. Those rules live in the engine, not in a skill file, because no market gets to opt out of them.
