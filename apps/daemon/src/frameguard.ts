/**
 * RT-424: boundary verdict for an incoming `RelayFrame` envelope, before any
 * crypto or session state is touched. Envelope metadata is attacker-
 * controllable (the relay is not trusted by the threat model), so a malformed
 * `seq`/`from`/`payload` must be dropped here instead of reaching `seqAad`
 * (which used to throw `RangeError`/`TypeError` on `BigInt(1.5)`, `null.from`,
 * ...) — an unauthenticated remote DoS.
 *
 * Pure on purpose (helloguard/pairwindow house pattern): one verdict function,
 * evaluated at the single point both transports (relay + local ws) pass
 * through. No I/O, no clock, no logging — never log seq/payload, and `from`
 * only as a sliced string at the call site.
 */
import { frameSeq, type RelayFrame } from "@ocr/protocol";

export type FrameRejectReason = "not-object" | "bad-from" | "bad-payload" | "bad-seq";

export type FrameVerdict =
  | { ok: true; frame: RelayFrame & { seq: number } }
  | { ok: false; reason: FrameRejectReason };

/**
 * Validate the clear envelope shape: an object with string `from`, string
 * `payload` and a `seq` that is a non-negative safe integer (or absent —
 * `undefined`/`null` normalize to 0). `room` is intentionally not checked:
 * the daemon does not route on it. Control frames (hello/ping) carry no seq
 * and pass with seq 0.
 */
export function frameVerdict(raw: unknown): FrameVerdict {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "not-object" };
  }
  const f = raw as { room?: unknown; from?: unknown; seq?: unknown; payload?: unknown };
  if (typeof f.from !== "string") return { ok: false, reason: "bad-from" };
  if (typeof f.payload !== "string") return { ok: false, reason: "bad-payload" };
  const seq = frameSeq(f.seq);
  if (seq === null) return { ok: false, reason: "bad-seq" };
  return {
    ok: true,
    frame: { room: f.room as string, from: f.from, seq, payload: f.payload },
  };
}
