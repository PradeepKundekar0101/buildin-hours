import { EventEmitter } from "node:events";

/**
 * Live theater feed.
 *
 * Deliberately plain SSE from the orchestrator rather than Supabase Realtime: the
 * events originate here, so routing them through the database and back adds a hop,
 * a schema, and a failure mode on the one surface the judges actually watch.
 * Supabase still stores everything for the index and the counters.
 */

export type MissionEvent = { type: string; [k: string]: unknown };

class EventBus {
  private emitter = new EventEmitter();
  /** Replay buffer so a browser that connects mid-mission still sees the story. */
  private history = new Map<string, MissionEvent[]>();

  constructor() {
    this.emitter.setMaxListeners(200);
  }

  emit(missionId: string, event: MissionEvent): void {
    const stamped = { ...event, at: Date.now() };
    const log = this.history.get(missionId) ?? [];
    log.push(stamped);
    if (log.length > 500) log.shift();
    this.history.set(missionId, log);
    this.emitter.emit(missionId, stamped);
    this.emitter.emit("*", { mission_id: missionId, ...stamped });
  }

  subscribe(missionId: string, cb: (e: MissionEvent) => void): () => void {
    for (const past of this.history.get(missionId) ?? []) cb(past);
    this.emitter.on(missionId, cb);
    return () => this.emitter.off(missionId, cb);
  }

  subscribeAll(cb: (e: MissionEvent) => void): () => void {
    this.emitter.on("*", cb);
    return () => this.emitter.off("*", cb);
  }

  replay(missionId: string): MissionEvent[] {
    return this.history.get(missionId) ?? [];
  }
}

export const bus = new EventBus();
