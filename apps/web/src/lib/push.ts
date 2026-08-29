import type { OcrClient } from "./client";

type RequestFn = (
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string>,
) => Promise<{ status: number; body: unknown }>;

function urlB64ToUint8Array(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Registers the service worker, subscribes to push and ships the
 * subscription to the daemon through the E2E tunnel. Must be called from a
 * user gesture on iOS (installed PWA, 16.4+).
 */
export async function enablePush(request: RequestFn): Promise<string> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("Web Push not supported in this browser");
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission denied");

  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const client = (window as unknown as { __ocrClient?: OcrClient }).__ocrClient;
  const vapid = client?.vapidKey;
  if (!vapid) throw new Error("pairing without VAPID key; re-pair the daemon");

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8Array(vapid),
    });
  }
  const res = await request("POST", "/__ocr/push-subscription", sub.toJSON());
  if (res.status !== 200) throw new Error("daemon rejected push subscription");
  return sub.endpoint;
}

/**
 * Silent restore: if this device already has permission + a push subscription,
 * re-sync it with the daemon so the user never re-authorizes. Returns the
 * endpoint when restored, null when the user must tap "Enable push" first.
 */
export async function restorePush(request: RequestFn): Promise<string | null> {
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
    if (Notification.permission !== "granted") return null;
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return null;
    const res = await request("POST", "/__ocr/push-subscription", sub.toJSON());
    return res.status === 200 ? sub.endpoint : null;
  } catch {
    return null;
  }
}
