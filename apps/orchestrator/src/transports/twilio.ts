import type { WebSocket } from "ws";
import twilio from "twilio";
import { env } from "../env.js";
import { log } from "../log.js";
import { openStt, type SttSession } from "../sarvam/stt.js";
import { synthesize } from "../sarvam/tts.js";
import type { Transport, TransportEndReason } from "../engine/transport.js";
import type { SkillPack } from "../skills/schema.js";
import type { Counterparty } from "../engine/types.js";

/**
 * Twilio Media Streams <-> Sarvam, mulaw 8k end to end.
 *
 * There is no transcode layer in this file, and that is the point: Twilio's frames
 * go straight into Sarvam's realtime socket, and Bulbul's mulaw comes straight back
 * out to Twilio. Turn detection is Sarvam's server-side VAD, so nothing here counts
 * silence.
 */

const FRAME_BYTES = 160; // 20ms of mulaw at 8kHz

/** Media-stream sockets arrive after the dial, so transports park here waiting for theirs. */
const waiting = new Map<string, (ws: WebSocket) => void>();

export function attachMediaStream(callId: string, ws: WebSocket): boolean {
  const resolve = waiting.get(callId);
  if (!resolve) return false;
  waiting.delete(callId);
  resolve(ws);
  return true;
}

let _twilio: ReturnType<typeof twilio> | null = null;
function client() {
  if (!_twilio) _twilio = twilio(env.twilioSid, env.twilioToken);
  return _twilio;
}

export type TwilioOptions = {
  pack: SkillPack;
  counterparty: Counterparty;
  callId: string;
  openingLang: string;
};

export class TwilioTransport implements Transport {
  readonly kind = "pstn" as const;
  readonly id: string;
  recordingUrl: string | undefined;

  private ws: WebSocket | null = null;
  private streamSid: string | null = null;
  private twilioCallSid: string | null = null;
  private stt: SttSession | null = null;

  private utteranceCb: ((text: string, lang?: string) => void) | null = null;
  private bargeInCb: (() => void) | null = null;
  private endedCb: ((reason: TransportEndReason) => void) | null = null;

  /** Resolver for the mark that signals "playback finished". */
  private markResolvers = new Map<string, () => void>();
  private speaking = false;
  private dead = false;

  constructor(private opts: TwilioOptions) {
    this.id = opts.callId;
  }

  async start(): Promise<void> {
    const streamUrl = `${env.publicBaseUrl.replace(/^https/, "wss")}/media/${this.opts.callId}`;
    log.call(this.id, `dialling ${this.opts.counterparty.phone}`);

    const call = await client().calls.create({
      to: this.opts.counterparty.phone,
      from: env.twilioFrom,
      twiml:
        `<Response><Connect><Stream url="${streamUrl}">` +
        `<Parameter name="callId" value="${this.opts.callId}"/>` +
        `</Stream></Connect></Response>`,
      machineDetection: "Enable",
      asyncAmd: "true",
      asyncAmdStatusCallback: `${env.publicBaseUrl}/twilio/amd/${this.opts.callId}`,
      statusCallback: `${env.publicBaseUrl}/twilio/status/${this.opts.callId}`,
      statusCallbackEvent: ["answered", "completed"],
      record: true,
      recordingStatusCallback: `${env.publicBaseUrl}/twilio/recording/${this.opts.callId}`,
      timeout: 25,
    });
    this.twilioCallSid = call.sid;

    // Wait for Twilio to open the media stream back to us.
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(this.opts.callId);
        reject(new Error("media stream never connected (no answer)"));
      }, 35_000);
      waiting.set(this.opts.callId, (socket) => {
        clearTimeout(timer);
        resolve(socket);
      });
    });

    this.ws = ws;
    await this.bindSocket(ws);
    await this.openStt();
    log.call(this.id, "media stream live");
  }

  private async bindSocket(ws: WebSocket): Promise<void> {
    ws.on("message", (data) => {
      let msg: {
        event: string;
        streamSid?: string;
        media?: { payload: string };
        mark?: { name: string };
      };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      switch (msg.event) {
        case "start":
          this.streamSid = msg.streamSid ?? null;
          break;
        case "media":
          // Straight through. No decode, no resample.
          if (msg.media?.payload) this.stt?.push(msg.media.payload);
          break;
        case "mark": {
          const name = msg.mark?.name;
          if (name) {
            this.markResolvers.get(name)?.();
            this.markResolvers.delete(name);
          }
          break;
        }
        case "stop":
          this.end("hangup");
          break;
      }
    });

    ws.on("close", () => this.end("hangup"));
    ws.on("error", (err) => {
      log.call(this.id, `media socket error: ${err.message}`);
      this.end("failed");
    });
  }

  private async openStt(): Promise<void> {
    const skuPrompt = buildPrompt(this.opts.pack, this.opts.counterparty);
    this.stt = await openStt({
      label: `stt/${this.id.slice(0, 8)}`,
      prompt: skuPrompt,
      events: {
        onSpeechStart: () => {
          // They talked over us: drop everything Twilio has buffered immediately.
          if (this.speaking) {
            this.clearPlayback();
            this.bargeInCb?.();
          }
        },
        onFinal: (text, lang) => this.utteranceCb?.(text, lang),
        onError: (err) => log.call(this.id, `stt: ${err.message}`),
      },
    });
  }

  onUtterance(cb: (text: string, lang?: string) => void): void {
    this.utteranceCb = cb;
  }
  onBargeIn(cb: () => void): void {
    this.bargeInCb = cb;
  }
  onEnded(cb: (reason: TransportEndReason) => void): void {
    this.endedCb = cb;
  }

  async speak(text: string, lang: string): Promise<void> {
    if (this.dead || !this.ws || !this.streamSid) return;

    const audio = await synthesize({ text, lang, pack: this.opts.pack });
    if (this.dead || !this.ws || !this.streamSid) return;

    this.speaking = true;
    const markName = `m${Date.now()}${Math.floor(Math.random() * 1000)}`;

    for (let off = 0; off < audio.length; off += FRAME_BYTES) {
      const frame = audio.subarray(off, Math.min(off + FRAME_BYTES, audio.length));
      this.ws.send(
        JSON.stringify({
          event: "media",
          streamSid: this.streamSid,
          media: { payload: frame.toString("base64") },
        })
      );
    }
    this.ws.send(JSON.stringify({ event: "mark", streamSid: this.streamSid, mark: { name: markName } }));

    await new Promise<void>((resolve) => {
      // Resolve on the mark, on barge-in clearing us, or on a hard ceiling so a
      // dropped mark can never wedge the call.
      const ceiling = setTimeout(() => {
        this.markResolvers.delete(markName);
        resolve();
      }, Math.max(4000, (audio.length / 8000) * 1000 + 2500));

      this.markResolvers.set(markName, () => {
        clearTimeout(ceiling);
        resolve();
      });
    });

    this.speaking = false;
  }

  private clearPlayback(): void {
    if (!this.ws || !this.streamSid) return;
    this.ws.send(JSON.stringify({ event: "clear", streamSid: this.streamSid }));
    // Anything still waiting on a mark will never get one now.
    for (const [name, resolve] of this.markResolvers) {
      this.markResolvers.delete(name);
      resolve();
    }
    this.speaking = false;
  }

  /** Called by the AMD webhook. */
  notifyVoicemail(): void {
    log.call(this.id, "AMD: machine");
    this.end("voicemail");
  }

  notifyStatus(status: string): void {
    if (status === "no-answer" || status === "busy" || status === "canceled") this.end("no_answer");
    else if (status === "failed") this.end("failed");
    else if (status === "completed") this.end("completed");
  }

  notifyRecording(url: string): void {
    this.recordingUrl = url;
  }

  async hangup(): Promise<void> {
    if (this.twilioCallSid) {
      try {
        await client().calls(this.twilioCallSid).update({ status: "completed" });
      } catch {
        /* already ended */
      }
    }
    this.end("hangup");
  }

  private end(reason: TransportEndReason): void {
    if (this.dead) return;
    this.dead = true;
    this.stt?.close();
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    this.endedCb?.(reason);
  }
}

/** Bias recognition toward the words this call will actually contain. */
function buildPrompt(pack: SkillPack, cp: Counterparty): string {
  const words = [
    ...Object.keys(pack.fact_schema),
    ...pack.persona.honorifics,
    cp.name,
    ...Object.values(cp.attrs),
  ];
  return words.filter(Boolean).join(", ").slice(0, 400);
}

/** Live transports, so webhooks can reach the right one. */
export const liveTwilioTransports = new Map<string, TwilioTransport>();
