import { WebSocketServer, type WebSocket } from "ws";

/**
 * Relay: a blind router.
 *
 * It forwards encrypted frames between daemons and clients that share a room
 * id. It cannot decrypt payloads and does not authenticate them on purpose —
 * authentication is cryptographic and happens between the endpoints. If the
 * relay is hosted by an untrusted party, the E2E guarantees still hold.
 *
 * Resource limits keep a public relay from being trivially DoS'd.
 */

const PORT = Number(process.env.RELAY_PORT ?? 8787);
const MAX_FRAME = 1_000_000; // bytes; sealed op payloads are far smaller
const MAX_SOCKETS = 1000;
const MAX_PER_ROOM = 10;

interface Socket extends WebSocket {
  id?: string;
  rooms?: Set<string>;
}

const rooms = new Map<string, Set<Socket>>();

function join(socket: Socket, room: string) {
  socket.rooms ??= new Set();
  socket.rooms.add(room);
  let set = rooms.get(room);
  if (!set) {
    set = new Set();
    rooms.set(room, set);
  }
  set.add(socket);
}

function leaveAll(socket: Socket) {
  for (const room of socket.rooms ?? []) {
    rooms.get(room)?.delete(socket);
    if (rooms.get(room)?.size === 0) rooms.delete(room);
  }
}

function ev(level: "info" | "warn", msg: string, data?: unknown) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(data ? { data } : {}) }));
}

const wss = new WebSocketServer({ port: PORT, maxPayload: MAX_FRAME });
let counter = 0;

wss.on("connection", (socket: Socket) => {
  if (wss.clients.size > MAX_SOCKETS) {
    socket.close(1013, "server busy");
    return;
  }
  socket.id = `s${Date.now().toString(36)}${(counter++).toString(36)}`;
  socket.rooms = new Set();
  ev("info", "connection open", { id: socket.id, total: wss.clients.size });

  socket.on("message", (data) => {
    let frame: { room?: unknown; from?: unknown; seq?: unknown; payload?: unknown };
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (typeof frame.room !== "string" || typeof frame.payload !== "string") return;

    ev("info", "frame in", {
      room: frame.room.slice(0, 8),
      from: String(frame.from).slice(0, 10),
      targets: rooms.get(frame.room)?.size ?? -1,
    });

    // every frame's room is joined by its sender: both ends of a
    // conversation converge on the same room naturally
    join(socket, frame.room);
    if ((rooms.get(frame.room)?.size ?? 0) > MAX_PER_ROOM) {
      ev("warn", "room capacity exceeded", { room: frame.room.slice(0, 8) });
      socket.close(1013, "room full");
      return;
    }

    const targets = rooms.get(frame.room);
    if (!targets) return;
    const out = JSON.stringify({
      room: frame.room,
      from: frame.from ?? socket.id,
      seq: frame.seq,
      payload: frame.payload,
    });
    for (const t of targets) {
      if (t !== socket && t.readyState === t.OPEN) t.send(out);
    }
  });

  socket.on("close", () => {
    leaveAll(socket);
    ev("info", "connection closed", { id: socket.id, total: wss.clients.size });
  });
  socket.on("error", () => leaveAll(socket));
});

ev("info", "relay listening", { port: PORT, maxFrame: MAX_FRAME, maxPerRoom: MAX_PER_ROOM });
