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

export async function openStt(opts: {
  events: SttEvents;
  /** Domain words - SKU names, brand names - that bias recognition. */
  prompt?: string;
  /** Milliseconds of silence before the server closes a turn. Lower = snappier, more cut-offs. */
  silenceMs?: number;
  label?: string;
}): Promise<SttSession> {
  const { events } = opts;
  const label = opts.label ?? "stt";

  const socket = await sarvam().speechToTextRealtimeStreaming.connect({
    language_code: "auto",
    model: "saaras:v3-realtime",
    encoding: "mulaw",
    sample_rate: "8000",
    endpointing: "vad",
    stream_type: "fast",
    mode: "codemix",
    silence_duration_ms: String(opts.silenceMs ?? 600),
    min_speech_duration_ms: "120",
    ...(opts.prompt ? { prompt: opts.prompt } : {}),
    "Api-Subscription-Key": env.sarvamKey,
  });

  let ready = false;

  socket.on("open", () => {
    ready = true;
    log.info(`${label} socket open`);
  });

  socket.on("message", (raw) => {
    const msg = raw as unknown as RealtimeMessage;
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
      if (!ready) return;
      try {
        socket.sendRealtimeAudioInput({ event: "audio_input", audio: base64Mulaw });
      } catch (e) {
        events.onError?.(e instanceof Error ? e : new Error(String(e)));
      }
    },
    flush() {
      if (!ready) return;
      try {
        socket.sendRealtimeFlush({ event: "flush" });
      } catch {
        /* socket already gone */
      }
    },
    close() {
      ready = false;
      try {
        socket.sendRealtimeEnd({ event: "end" });
      } catch {
        /* already closed */
      }
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
