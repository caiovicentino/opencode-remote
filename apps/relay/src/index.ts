import { WebSocketServer, type WebSocket } from "ws";

/**
 * Relay: a blind router.
 *
 * It forwards encrypted frames between daemons and clients that share a room
 * id. It cannot decrypt payloads and does not authenticate them on purpose —
 * authentication is cryptographic and happens between the endpoints. If the
 * relay is hosted by an untrusted party, the E2E guarantees still hold.
 *
 * Deployment note (enterprise): this file is the entire server. Run it inside
 * your own network with `RELAY_PORT` and no external dependencies.
 */

const PORT = Number(process.env.RELAY_PORT ?? 8787);

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

const wss = new WebSocketServer({ port: PORT });
let counter = 0;

wss.on("connection", (socket: Socket) => {
  socket.id = `s${Date.now().toString(36)}${(counter++).toString(36)}`;
  socket.rooms = new Set();

  socket.on("message", (data) => {
    let frame: { room?: unknown; from?: unknown; seq?: unknown; payload?: unknown };
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (typeof frame.room !== "string" || typeof frame.payload !== "string") return;

    // every frame's room is joined by its sender: both ends of a
    // conversation converge on the same room naturally
    join(socket, frame.room);

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

  socket.on("close", () => leaveAll(socket));
  socket.on("error", () => leaveAll(socket));
});

console.log(`[relay] listening on ws://0.0.0.0:${PORT}`);
