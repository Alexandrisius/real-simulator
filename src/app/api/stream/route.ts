import { getHub } from "@/lib/engine/hub";

export const dynamic = "force-dynamic";

/** GET /api/stream?sceneId=1 — SSE: события сцены, статусы движка, обновления участников. */
export async function GET(req: Request) {
  const sceneId = Number(new URL(req.url).searchParams.get("sceneId") ?? 0);
  if (!Number.isInteger(sceneId) || sceneId <= 0) {
    return new Response("sceneId required", { status: 400 });
  }
  const hub = getHub();
  const encoder = new TextEncoder();
  let cleanupRef: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      send({ type: "hello" });

      const onEvent = (event: { sceneId: number }) => {
        if (event.sceneId === sceneId) send({ type: "event", event });
      };
      const onStatus = (payload: { sceneId: number }) => {
        if (payload.sceneId === sceneId) send({ type: "status", ...payload });
      };
      const onParticipants = (payload: { sceneId: number }) => {
        if (payload.sceneId === sceneId) send({ type: "participants", sceneId });
      };
      const onToolRequests = (payload: { sceneId: number }) => {
        if (payload.sceneId === sceneId) send({ type: "tool-requests", sceneId });
      };

      hub.on("event", onEvent);
      hub.on("status", onStatus);
      hub.on("participants", onParticipants);
      hub.on("tool-requests", onToolRequests);

      const heartbeat = setInterval(() => send({ type: "heartbeat" }), 25000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        hub.off("event", onEvent);
        hub.off("status", onStatus);
        hub.off("participants", onParticipants);
        hub.off("tool-requests", onToolRequests);
        try {
          controller.close();
        } catch {
          // уже закрыт
        }
      };
      req.signal.addEventListener("abort", cleanup);
      cleanupRef = cleanup;
    },
    cancel() {
      // Стрим отменён потребителем (клиент ушёл) — останавливаем heartbeat.
      cleanupRef?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
