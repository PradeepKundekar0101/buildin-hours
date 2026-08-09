import { SarvamAIClient } from "sarvamai";
import { env, has } from "../env.js";

let _client: SarvamAIClient | null = null;

export function sarvam(): SarvamAIClient {
  if (!has.sarvam()) {
    throw new Error("SARVAM_API_KEY is not set - the engine cannot listen, think, or speak without it");
  }
  if (!_client) {
    _client = new SarvamAIClient({ apiSubscriptionKey: env.sarvamKey });
  }
  return _client;
}
