import { getCredentialId, setCredentialId } from "./client";

/**
 * WebAuthn gate: the non-extractable identity key is only usable after a
 * successful user-verification (Face ID / Touch ID / PIN). Enrollment is
 * optional and only offered in secure contexts; verification is enforced
 * whenever a credential has been enrolled.
 */
export const gateAvailable =
  typeof window !== "undefined" &&
  "PublicKeyCredential" in window &&
  window.isSecureContext;

export async function gateEnroll(): Promise<boolean> {
  if (!gateAvailable || (await getCredentialId()) !== null) return false;
  try {
    const cred = (await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(new ArrayBuffer(32))),
        rp: { name: "OpenCode Remote" },
        user: {
          id: crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16))),
          name: "opencode-remote",
          displayName: "OpenCode Remote",
        },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 }, // ES256
          { type: "public-key", alg: -257 }, // RS256
        ],
        authenticatorSelection: {
          userVerification: "required",
          residentKey: "preferred",
        },
        timeout: 60_000,
      },
    })) as PublicKeyCredential | null;
    if (!cred) return false;
    await setCredentialId(cred.rawId);
    return true;
  } catch {
    return false;
  }
}

export async function gateVerify(): Promise<boolean> {
  const credId = await getCredentialId();
  if (!credId) return true; // nothing enrolled -> no gate
  try {
    await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(new ArrayBuffer(32))),
        allowCredentials: [{ type: "public-key", id: credId }],
        userVerification: "required",
        timeout: 60_000,
      },
    });
    return true;
  } catch {
    return false;
  }
}
