const te = new TextEncoder();
const td = new TextDecoder();

const subtle = crypto.subtle; // Node 22+ and browsers ship WebCrypto

export interface Identity {
  /** SPKI base64 */
  publicKey: string;
  /** non-extractable on browser clients */
  privateKey: CryptoKey;
}

export function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(new ArrayBuffer(len));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** copy into a plain ArrayBuffer (WebCrypto hates offset views) */
function ab(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.length);
  new Uint8Array(out).set(bytes);
  return out;
}

export interface DaemonHello {
  clientPub: string;
  nonce: string;
  token: string;
}

export interface ServerAccept {
  ok: true;
  confirm: string;
}

const HELLO_AAD = "ocr-hello";
const CONFIRM_AAD = "ocr-confirm";

/** Generate a new identity. Clients must keep extractable=false. */
export async function newIdentity(extractable = false): Promise<Identity> {
  const kp = await subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    extractable,
    ["deriveBits"],
  );
  const spki = await subtle.exportKey("spki", kp.publicKey);
  return { publicKey: b64(new Uint8Array(spki)), privateKey: kp.privateKey };
}

/** Daemon-side: rehydrate an identity persisted as PKCS8. */
export async function importPrivateIdentity(
  publicKeySpki: string,
  pkcs8: Uint8Array,
): Promise<Identity> {
  const priv = await subtle.importKey(
    "pkcs8",
    ab(pkcs8),
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  return { publicKey: publicKeySpki, privateKey: priv };
}

export async function exportPkcs8(identity: Identity): Promise<Uint8Array> {
  const raw = await subtle.exportKey("pkcs8", identity.privateKey);
  return new Uint8Array(raw);
}

async function deriveAesKey(
  priv: CryptoKey,
  peerSpkiB64: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const peer = await subtle.importKey(
    "spki",
    ab(fromB64(peerSpkiB64)),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = await subtle.deriveBits({ name: "ECDH", public: peer }, priv, 256);
  const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: ab(salt), info: te.encode("opencode-remote v2") },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** AAD binding for data frames: sender id + sequence number. */
export function seqAad(from: string, seq: number): Uint8Array {
  const f = te.encode(from);
  const out = new Uint8Array(new ArrayBuffer(f.length + 8));
  out.set(f, 0);
  new DataView(out.buffer).setBigUint64(f.length, BigInt(seq));
  return out;
}

/**
 * Client -> daemon handshake. The token is sealed with the very session key
 * it derives, so only the daemon that owns `daemonPub` can open it: mutual
 * authentication without any trusted third party.
 */
export async function clientHello(
  daemonPub: string,
  identity: Identity,
): Promise<{ hello: DaemonHello; sessionKey: CryptoKey }> {
  const salt = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)));
  const sessionKey = await deriveAesKey(identity.privateKey, daemonPub, salt);
  const token = await seal({ clientPub: identity.publicKey }, sessionKey, te.encode(HELLO_AAD));
  return { hello: { clientPub: identity.publicKey, nonce: b64(salt), token }, sessionKey };
}

/** Daemon side: verify the client token and derive the same session key. */
export async function serverAccept(
  hello: DaemonHello,
  daemonIdentity: Identity,
): Promise<{ clientPub: string; sessionKey: CryptoKey } | null> {
  try {
    const sessionKey = await deriveAesKey(
      daemonIdentity.privateKey,
      hello.clientPub,
      fromB64(hello.nonce),
    );
    const token = await openSealed<{ clientPub: string }>(
      hello.token,
      sessionKey,
      te.encode(HELLO_AAD),
    );
    if (!token || token.clientPub !== hello.clientPub) return null;
    return { clientPub: hello.clientPub, sessionKey };
  } catch {
    return null;
  }
}

export async function acceptPayload(sessionKey: CryptoKey): Promise<ServerAccept> {
  return { ok: true, confirm: await seal({ ok: true }, sessionKey, te.encode(CONFIRM_AAD)) };
}

/** Encrypt JSON: base64(nonce12 || ciphertext || tag16). */
export async function seal(obj: unknown, key: CryptoKey, aad?: Uint8Array): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const ct = await subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: aad ? ab(aad) : undefined,
      tagLength: 128,
    },
    key,
    te.encode(JSON.stringify(obj)),
  );
  return b64(concat(nonce, new Uint8Array(ct)));
}

/** Decrypt a payload produced by `seal`. Returns null on failure. */
export async function openSealed<T = unknown>(
  payload: string,
  key: CryptoKey,
  aad?: Uint8Array,
): Promise<T | null> {
  try {
    const raw = fromB64(payload);
    const nonce = raw.slice(0, 12);
    const ct = raw.slice(12);
    const pt = await subtle.decrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: aad ? ab(aad) : undefined,
        tagLength: 128,
      },
      key,
      ab(ct),
    );
    return JSON.parse(td.decode(pt)) as T;
  } catch {
    return null;
  }
}
