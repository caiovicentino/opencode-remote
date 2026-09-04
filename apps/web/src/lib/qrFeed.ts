/** P2-117: pure decision core of the QR scanner's camera state machine.
 * Framework-free so the unit battery can hold the contract without a
 * renderer (docs/EXPERIENCE.md, P3-086 pattern). */

export type FeedVerdict = "preview" | "empty";

export interface FeedSample {
  /** Frames observed via requestVideoFrameCallback / the polling fallback. */
  frames: number;
  /** video.videoWidth — 0 until the first real frame is decoded. */
  videoWidth: number;
  /** MediaTrack.readyState === "ended" (camera unplugged, feed lost). */
  trackEnded: boolean;
  /** ms since the stream started playing. */
  elapsedMs: number;
}

/** Grace period before a silent feed is declared empty. Generous because
 * some USB cameras take 1-2s to emit the first frame after getUserMedia. */
export const FEED_GRACE_MS = 4_000;

/** A feed that never produces a frame (capture device with no input — the
 * "NO SIGNAL" class of devices — stalled driver, unplugged camera) is
 * camera-unavailable for the user's purpose. The scanner must show the
 * unavailable state with the paste-code fallback instead of a dead black
 * box that eventually leaks the device's own OSD placeholder. */
export function feedVerdict(s: FeedSample): FeedVerdict {
  if (s.trackEnded) return "empty";
  if (s.elapsedMs >= FEED_GRACE_MS && (s.frames === 0 || s.videoWidth === 0)) return "empty";
  return "preview";
}
