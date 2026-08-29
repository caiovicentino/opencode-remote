/**
 * Wire protocol between PWA client, relay and daemon.
 *
 * The relay only ever sees `RelayFrame` envelopes whose `payload` is an
 * opaque base64 ciphertext. It cannot read, alter or forge contents.
 */

/** Pairing URI scheme embedded in the QR code shown by the daemon. */
export interface PairingInfo {
  /** protocol version */
  v: 2;
  /** relay websocket URL, e.g. wss://relay.example.com */
  relay: string;
  /** daemon room id on the relay (random, per-daemon) */
  room: string;
  /** daemon ECDH P-256 public key (SPKI base64) */
  k: string;
  /** VAPID public key for Web Push (base64url), if the daemon has one */
  vapid?: string;
  /** human-readable machine label */
  name?: string;
}

/** What the PWA sends to the relay (and vice versa) over its WebSocket. */
export interface RelayFrame {
  /** room id — daemon id or broadcast channel */
  room: string;
  /** sender id (random per connection) */
  from: string;
  /** base64 of encrypted `ClientEnvelope` / `DaemonEnvelope` */
  payload: string;
  /** monotonic per-sender sequence number (replay protection) */
  seq?: number;
}

/** Encrypted request from PWA -> daemon (opens into OpRequest). */
export interface ClientEnvelope {
  type: "op";
  req: OpRequest;
}

/** Encrypted message from daemon -> PWA (opens into OpResponse or EventEnvelope). */
export type DaemonEnvelope =
  | { type: "res"; res: OpResponse }
  | { type: "event"; event: EventEnvelope };

/** HTTP-shaped tunnel request over the encrypted channel. */
export interface OpRequest {
  id: string;
  method: "GET" | "POST" | "DELETE" | "PATCH" | "PUT";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

export interface OpResponse {
  id: string;
  status: number;
  body: unknown;
}

/** An opencode server SSE event forwarded to clients. */
export interface EventEnvelope {
  id: string;
  type: string;
  properties: unknown;
}
