// Шина событий для SSE: движок публикует, /api/stream подписывается.

import { EventEmitter } from "node:events";
import type { SceneStatus, SimEvent } from "@/lib/types";

export interface StatusPayload {
  sceneId: number;
  status: SceneStatus;
  turn: number;
  nextCharacterId: number | null;
}

class Hub extends EventEmitter {
  emitEvent(event: SimEvent): void {
    this.emit("event", event);
  }
  emitStatus(payload: StatusPayload): void {
    this.emit("status", payload);
  }
  emitParticipants(sceneId: number): void {
    this.emit("participants", { sceneId });
  }
  emitToolRequests(sceneId: number): void {
    this.emit("tool-requests", { sceneId });
  }
}

const g = globalThis as unknown as { __simHub?: Hub };

export function getHub(): Hub {
  if (!g.__simHub) {
    g.__simHub = new Hub();
    g.__simHub.setMaxListeners(100);
  }
  return g.__simHub;
}
