import WebSocket from "ws";
import { sarvam } from "./client.js";
import { env } from "../env.js";
import { log } from "../log.js";

/**
 * Realtime STT over `saaras:v3-realtime`.
 *
 * Verified against sarvamai@1.1.8:
 *   - `encoding: "mulaw"` + `sample_rate: "8000"` accepts Twilio frames byte-for-byte
 *   - `endpointing: "vad"` gives server-side turn detection, so there is no local
 *     silence timer in the hot path at all
 *   - `language_code: "auto"` returns the detected language on every final transcript,
 *     which is what picks the Bulbul voice for the reply
 *   - `mode: "codemix"` keeps Hinglish/Kanglish as people actually say it
 */

export type SttEvents = {
  /** Caller started talking. Fires during our playback too - this is the barge-in trigger. */
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  onPartial?: (text: string) => void;
  onFinal?: (text: string, lang?: string) => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
};

export type SttSession = {
  /** Feed one base64 mulaw@8k chunk straight off the Twilio media event. */
  push: (base64Mulaw: string) => void;
  /** Force finalisation of whatever is buffered (used when the far end goes quiet). */
  flush: () => void;
  close: () => void;
  readonly ready: boolean;
};

type RealtimeMessage = {
  event: string;
  text?: string;
  language?: string;
  language_confidence?: number;
  utterance_idx?: number;
  message?: string;
};

const REALTIME_URL = "wss://api.sarvam.ai/speech-to-text-realtime/ws";

/**
 * We open this socket with `ws` directly instead of through the SDK, deliberately.
 *
 * sarvamai@1.1.8 picks its WebSocket implementation like this:
 *
 *     if (typeof WebSocket !== "undefined") return WebSocket;   // Node 22 global
 *     else if (RUNTIME.type === "node") return NodeWebSocket;   // the 'ws' package
 *
 * Node 22 ships a global WebSocket that ignores the options argument, so the
 * `api-subscription-key` header the SDK carefully assembles is silently dropped and
 * the server answers "Invalid subscription key". On Node 18 or 20 the same code
 * falls through to `ws` and works. Verified against the live endpoint: the header is
 * accepted, the query parameter is rejected, so the header is the only way in.
 */
export async function openStt(opts: {
  events: SttEvents;
  /** Domain words - SKU names, brand names - that bias recognition. */
  prompt?: string;
  /** Milliseconds of silence before the server closes a turn. Lower = snappier, more cut-offs. */
  silenceMs?: number;
  /** VAD sensitivity 0-1. Higher ignores more background noise. */
  threshold?: number;
  /** Minimum speech before a turn opens. The main defence against a noisy room. */
  minSpeechMs?: number;
  label?: string;
}): Promise<SttSession> {
  const { events } = opts;
  const label = opts.label ?? "stt";

  const query = new URLSearchParams({
    language_code: "auto",
    model: "saaras:v3-realtime",
    encoding: "mulaw",
    sample_rate: "8000",
    endpointing: "vad",
    stream_type: "fast",
    mode: "codemix",
    // Tuned for a speakerphone in a loud room, which is the actual demo condition.
    // 120ms of anything opened a turn, so nearby conversation was being transcribed
    // as the shopkeeper. 350ms and a higher threshold keep the floor with the caller.
    silence_duration_ms: String(opts.silenceMs ?? 700),
    min_speech_duration_ms: String(opts.minSpeechMs ?? 350),
    threshold: String(opts.threshold ?? 0.6),
    ...(opts.prompt ? { prompt: opts.prompt.slice(0, 400) } : {}),
  });

  const socket = new WebSocket(`${REALTIME_URL}?${query}`, {
    headers: { "api-subscription-key": env.sarvamKey },
  });

  let ready = false;
  /** Audio that arrives before the socket finishes opening. The caller's first
   *  sentence is the most important one; dropping it is not acceptable. */
  const backlog: string[] = [];

  const send = (payload: unknown) => {
    if (socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  };

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("sarvam realtime socket did not open in 10s")), 10_000);

    socket.once("open", () => {
      clearTimeout(timer);
      ready = true;
      log.info(`${label} socket open`);
      for (const chunk of backlog.splice(0)) send({ event: "audio_input", audio: chunk });
      resolve();
    });

    socket.once("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      reject(new Error(`sarvam realtime rejected the handshake: HTTP ${res.statusCode}`));
    });

    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });

  socket.on("message", (raw) => {
    let msg: RealtimeMessage;
    try {
      msg = JSON.parse(raw.toString()) as RealtimeMessage;
    } catch {
      return;
    }

    switch (msg.event) {
      case "session.begin":
        break;
      case "vad.speech_start":
        events.onSpeechStart?.();
        break;
      case "vad.speech_end":
        events.onSpeechEnd?.();
        break;
      case "transcript.partial":
        if (msg.text) events.onPartial?.(msg.text);
        break;
      case "transcript.final":
        if (msg.text?.trim()) events.onFinal?.(msg.text.trim(), msg.language);
        break;
      case "error":
        // An auth or parameter error here means every frame we send is going into
        // a void. Say so loudly rather than letting the call go quietly deaf.
        ready = false;
        events.onError?.(new Error(msg.message ?? "sarvam realtime error"));
        break;
      case "session.end":
        events.onClose?.();
        break;
      default:
        break;
    }
  });

  socket.on("error", (err) => events.onError?.(err instanceof Error ? err : new Error(String(err))));
  socket.on("close", () => {
    ready = false;
    events.onClose?.();
  });

  return {
    get ready() {
      return ready;
    },
    push(base64Mulaw: string) {
      if (!ready) {
        if (backlog.length < 250) backlog.push(base64Mulaw); // ~5s of audio
        return;
      }
      try {
        send({ event: "audio_input", audio: base64Mulaw });
      } catch (e) {
        events.onError?.(e instanceof Error ? e : new Error(String(e)));
      }
    },
    flush() {
      send({ event: "flush" });
    },
    close() {
      ready = false;
      send({ event: "end" });
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/**
 * Batch fallback, used when FALLBACK_VAD=1 or the realtime socket refuses to open.
 * Takes raw mulaw and lets Sarvam decode it - still no local transcoding.
 */
export async function transcribeBatch(mulaw: Buffer): Promise<{ text: string; lang?: string }> {
  const res = await sarvam().speechToText.transcribe({
    file: new Blob([new Uint8Array(mulaw)]) as never,
    model: "saarika:v2.5" as never,
    language_code: "unknown" as never,
    input_audio_codec: "mulaw" as never,
  } as never);
  const r = res as { transcript?: string; language_code?: string };
  return { text: r.transcript ?? "", lang: r.language_code };
}
