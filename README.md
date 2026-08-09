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

The `.env` lives at the **workspace root**, not inside `apps/*` - both apps are wired to read it from there.

Apply the database schema once, or nothing persists and the counters stay at zero:
paste `apps/orchestrator/sql/schema.sql` into the Supabase SQL editor.

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

```bash
pnpm twilio:check
```

Run that before every rehearsal. It catches the failures that are invisible until you dial: geo permissions blocking India, a placeholder tunnel URL, a trial account, a number without voice capability.

**You do not configure anything on the number itself.** The Voice URL and Messaging URL in the console govern *inbound* calls. MolBhav dials outbound and passes its TwiML inline on `calls.create()`, so there is no webhook to point anywhere and no TwiML App to create. A number fresh out of the box, still pointing at `demo.twilio.com`, works.

What you actually need:

1. **Account SID and Auth Token** - console home page, Account Info panel. SID starts with `AC`.
2. **The number in E.164** - `TWILIO_FROM_NUMBER=+15188643842`, no spaces or dashes.
3. **A public HTTPS tunnel**, because Twilio has to open a media stream *back* to your laptop:
   ```bash
   ngrok http 8080
   ```
   Put the https URL in `PUBLIC_BASE_URL`. The stream lands on `wss://<host>/media/:callId`.
4. **Geo permissions for India** - Voice → Settings → Geo Permissions. Off by default for most accounts; calls fail with error 21215 until it is ticked.

**Trial accounts cannot do this demo.** Two blockers, both fatal on stage: you can only dial numbers you have verified in the console, and Twilio plays its own "you have a trial account" announcement to whoever answers - over your opener, before the counterparty has heard a word from you. Upgrade, or run the demo against verified teammate numbers.

### Test mode

Real telephony, real Sarvam, real barge-in - but every call rings *your* phone instead of a shop. You answer and play the shopkeeper while the board shows "Sangeetha Mobiles Koramangala" negotiating in Kannada.

```
TEST_CALL_REDIRECT=+917411420401
```

Toggle it in the composer, or per request:

```jsonc
{ "skill_id": "electronics", "spec": { ... }, "test": true }
// optionally override the number for this run:
{ "test": true, "test_number": "+919876543210" }
```

What changes when it is on, and nothing else does:

- every call dials the redirect number, keeping its counterparty's name, language, and persona
- **only one counterparty is rung** (`TEST_CALL_COUNT`, or `test_calls` per request). You are rehearsing one conversation, not answering the same call five times. Raise it to 2 when you want to rehearse the cross-call leverage beat, which needs a second quote on the bus before it can fire
- calls run **one at a time** - one human cannot answer six phones
- the calling-window guard is skipped, since no shop is being disturbed
- the mission is tagged `test` and is excluded from the savings counter, the call count, and the Bhav Index
- the board carries a `TEST RUN` banner naming the number being rung

That last pair matters more than it looks. A rehearsal that quietly inflates the number on the wall is a number you cannot show a judge.

This is also the **only way to place a real PSTN call on a trial account**, since trial can only dial numbers you have verified - and your own number already is.

**A +1 caller ID is a pickup-rate problem.** Nothing in this codebase can fix what the shopkeeper sees on their screen: an unknown US number. Expect a lot of unanswered calls. Twilio cannot originate calls *within* India for regulatory reasons, which is why the spec's Exotel side-quest exists.

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
| Which chat models exist? | `sarvam-m` is **deprecated (400)**. `sarvam-105b` is a reasoning model that spends its whole budget thinking and returns `content: null` at phone-call token caps. Only **`sarvam-105b-conversations`** is usable | Both `NEGOTIATE_MODEL` and `FAST_MODEL` point at it |
| Guaranteed JSON? | **No.** `json_schema` mode is degenerate - the model emits a valid object then floods whitespace to the token cap, ~13s, invalid. `json_object` works, ~2s | The contract is `json_object` plus a literal shape in the prompt, with retry and salvage behind it |

**The Node 22 trap.** `sarvamai@1.1.8` selects its WebSocket with `typeof WebSocket !== "undefined" ? WebSocket : require("ws")`. Node 22 ships a global `WebSocket` that ignores the options argument, so the `api-subscription-key` header the SDK assembles is silently dropped and the realtime STT socket answers *"Invalid subscription key"* - with a key that works perfectly over REST. On Node 18 or 20 the same code falls through to `ws` and works, which makes this look like an account problem rather than a runtime one.

`sarvam/stt.ts` therefore opens that socket with `ws` directly. Verified against the live endpoint: the header is accepted and the query parameter is rejected, so the header is the only way in.

**The tunnel trap.** Twilio is an anonymous client. A VS Code dev tunnel is private by default, so it works in your browser (which carries a session cookie) and returns 401 to Twilio - and refuses the websocket upgrade, which Twilio reports only as `error 31920`. `pnpm twilio:check` now probes both the HTTP endpoint and a real websocket upgrade anonymously.

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
- **Retry-and-salvage instead of trusting structured outputs.** About one turn in five comes back malformed - either whitespace-flooded to the cap, or with the sentence present but the key missing (`{ "Yeh price abhi valid hai." }`). `sarvam/chat.ts` retries once at low temperature, then repairs truncated objects, then reads a keyless reply as the primary field. Measured over a four-line mission: 7 retries, 4 salvages, **0 hard failures**. Going silent on a live phone call is not an acceptable way to handle a malformed token stream.

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
