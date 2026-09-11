/**
 * P2-331: version of the wire protocol itself — the shape of `RelayFrame`
 * and of the join sequence a peer speaks against the relay. It exists so a
 * hosted relay (stage 4) can announce, on the unauthenticated /healthz
 * probe, which frame format it routes: an installed machine can then tell
 * "relay temporarily unreachable" (reconnect) apart from "relay speaks a
 * frame format this build never learned" (a real upgrade is required).
 *
 * The value is independent from the package version and only ever bumps on
 * an INCOMPATIBLE change — a change that makes an old peer unable to join
 * or exchange frames with a new relay. Additive, backwards-compatible
 * changes keep the number. It matches the `v` field of the pairing payload
 * today; that equality is incidental, not a shared version: the pairing
 * URI evolves with the daemon/PWA handshake, this constant with the relay
 * frame format and join sequence.
 *
 * This module is deliberately plain JavaScript with no imports: the relay
 * image runs the tsc-compiled dist and imports the constant at runtime, so
 * the file must load without any TypeScript stripping step (the `.d.ts`
 * beside it carries the types).
 */
export const RELAY_WIRE_PROTOCOL = 2;
