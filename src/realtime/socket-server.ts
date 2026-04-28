import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { notificationStore } from "../notifications/store.js";
import { TurnCoordinator } from "../orchestrator/turn-coordinator.js";
import { getCapabilities } from "../harness/capabilities.js";
import { listProviders } from "../harness/providers/index.js";
import type { ClientEnvelope } from "./protocol.js";
import type { MonitorSource } from "../scheduler/monitor-source.js";
import { LocalMonitorSource } from "../scheduler/local-monitor-source.js";
import type { HermesSkillsBridge } from "../scheduler/hermes-skills-bridge.js";

export interface RealtimeServerOptions {
  harnessProvider: string;
  monitorSource?: MonitorSource;
  skillsBridge?: HermesSkillsBridge;
}

const require = createRequire(import.meta.url);
const wsLib = require("ws") as any;
const WebSocketCtor: any = wsLib.WebSocket ?? wsLib.default ?? wsLib;
const WebSocketServerCtor: any = wsLib.WebSocketServer ?? wsLib.Server;

type ClientConnection = {
  id: string;
  socket: WebSocket;
};

function sendEnvelope(
  socket: any,
  envelope: { id?: string; createdAt?: string; type: string; payload: unknown }
): void {
  if (socket.readyState !== WebSocketCtor.OPEN) return;
  socket.send(
    JSON.stringify({
      id: envelope.id ?? randomUUID(),
      createdAt: envelope.createdAt ?? new Date().toISOString(),
      type: envelope.type,
      payload: envelope.payload,
    })
  );
}

function parseMessage(message: string): ClientEnvelope | null {
  try {
    return JSON.parse(message) as ClientEnvelope;
  } catch {
    return null;
  }
}

export function attachRealtimeServer(
  server: any,
  coordinator: TurnCoordinator,
  options: RealtimeServerOptions = { harnessProvider: "pi-coding-agent" }
): void {
  const wss = new WebSocketServerCtor({ noServer: true });
  const clients = new Map<string, ClientConnection>();
  const monitorSource: MonitorSource =
    options.monitorSource ?? new LocalMonitorSource();

  const unsubscribeCoordinator = coordinator.subscribe((eventType, payload) => {
    for (const client of clients.values()) {
      sendEnvelope(client.socket, {
        type: eventType,
        payload,
      });
    }
  });

  const unsubscribeNotifications = notificationStore.subscribe(
    (notification) => {
      for (const client of clients.values()) {
        sendEnvelope(client.socket, {
          type: "notification.created",
          payload: notification,
        });
      }
    },
    (notification) => {
      for (const client of clients.values()) {
        sendEnvelope(client.socket, {
          type: "notification.updated",
          payload: notification,
        });
      }
    }
  );

  const unsubscribeMonitors = monitorSource.subscribe((monitors) => {
    for (const client of clients.values()) {
      sendEnvelope(client.socket, {
        type: "monitor.updated",
        payload: { monitors },
      });
    }
  });

  const unsubscribeSkills = options.skillsBridge?.subscribe((skills) => {
    for (const client of clients.values()) {
      sendEnvelope(client.socket, {
        type: "skill.updated",
        payload: { skills },
      });
    }
  });

  server.on("upgrade", (request: any, socket: any, head: any) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/v1/ws") {
      return;
    }
    console.log("[realtime] upgrade request received");

    wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (socket: any) => {
    const clientId = randomUUID();
    const client: ClientConnection = { id: clientId, socket };
    clients.set(clientId, client);
    console.log(`[realtime] client connected ${clientId}`);

    socket.on("message", async (raw: any) => {
      const envelope = parseMessage(raw.toString("utf-8"));
      if (!envelope) {
        sendEnvelope(socket, {
          type: "error",
          payload: { message: "Invalid realtime message" },
        });
        return;
      }

      if (envelope.type === "client.hello") {
        console.log(`[realtime] client hello ${clientId}`);
        sendEnvelope(socket, {
          type: "connection.ready",
          payload: { serverTime: new Date().toISOString() },
        });
        sendEnvelope(socket, {
          type: "harness.snapshot",
          payload: {
            active: options.harnessProvider,
            providers: listProviders(),
            // Legacy fields for older mobile clients
            provider: options.harnessProvider,
            capabilities: getCapabilities(options.harnessProvider),
          },
        });
        sendEnvelope(socket, {
          type: "notification.snapshot",
          payload: { notifications: notificationStore.list(100) },
        });
        const monitors = await Promise.resolve(monitorSource.list());
        sendEnvelope(socket, {
          type: "monitor.snapshot",
          payload: { monitors },
        });
        if (options.skillsBridge) {
          sendEnvelope(socket, {
            type: "skill.snapshot",
            payload: { skills: options.skillsBridge.list() },
          });
        }
        return;
      }

      if (envelope.type === "settings.update") {
        const payload = envelope.payload as Record<string, unknown> | null;
        if (payload && typeof payload.tts === "boolean") {
          coordinator.ttsEnabled = payload.tts;
        }
        return;
      }

      if (envelope.type === "turn.cancel") {
        console.log(`[realtime] turn.cancel from ${clientId}`);
        coordinator.cancelCurrentTurn();
        return;
      }

      if (envelope.type === "turn.start") {
        console.log(`[realtime] turn.start from ${clientId}`);
        const text =
          typeof envelope.payload === "object" &&
          envelope.payload &&
          "text" in envelope.payload
            ? String((envelope.payload as { text: string }).text ?? "").trim()
            : "";
        if (!text) {
          sendEnvelope(socket, {
            type: "error",
            payload: { message: "Missing text in turn.start" },
          });
          return;
        }

        const tts =
          typeof envelope.payload === "object" &&
          envelope.payload &&
          "tts" in envelope.payload
            ? (envelope.payload as { tts: boolean }).tts !== false
            : true;

        const abortController = new AbortController();
        socket.once("close", () => abortController.abort());

        try {
          await coordinator.runForegroundTurn({
            prompt: text,
            tts,
            abortSignal: abortController.signal,
            send: (event, payload) => {
              sendEnvelope(socket, {
                type: event,
                payload,
              });
            },
          });
        } catch (error) {
          sendEnvelope(socket, {
            type: "error",
            payload: {
              message:
                error instanceof Error
                  ? error.message
                  : "Foreground turn failed",
            },
          });
        }
        return;
      }

      if (envelope.type === "notification.ack") {
        const notificationId =
          typeof envelope.payload === "object" &&
          envelope.payload &&
          "notificationId" in envelope.payload
            ? String(
                (envelope.payload as { notificationId: string }).notificationId
              )
            : "";
        if (!notificationId) {
          sendEnvelope(socket, {
            type: "error",
            payload: { message: "Missing notificationId in notification.ack" },
          });
          return;
        }

        const updated = notificationStore.acknowledge(notificationId);
        if (!updated) {
          sendEnvelope(socket, {
            type: "error",
            payload: { message: `Notification not found: ${notificationId}` },
          });
        }
        return;
      }

      sendEnvelope(socket, {
        type: "error",
        payload: { message: `Unknown realtime message type: ${envelope.type}` },
      });
    });

    socket.on("close", () => {
      console.log(`[realtime] client disconnected ${clientId}`);
      clients.delete(clientId);
    });
  });

  server.on("close", () => {
    unsubscribeCoordinator();
    unsubscribeNotifications();
    unsubscribeMonitors();
    unsubscribeSkills?.();
    wss.close();
  });
}
