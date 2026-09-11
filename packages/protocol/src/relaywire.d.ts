/**
 * P2-331: version of the wire protocol itself — the shape of `RelayFrame`
 * and of the join sequence a peer speaks against the relay. Only bumps on
 * an incompatible change; independent from the package version. See the
 * documented header in relaywire.js — the plain-JS module the relay dist
 * imports at runtime.
 */
export declare const RELAY_WIRE_PROTOCOL = 2;
