// P3-399: publishes the pending permission-ask count to the desktop shell so
// main can decide the "agent asks approval" notification — the same
// best-effort push design as lib/unread.ts's sendUnreadToShell, on its own
// preload channel (ocr:asks). Absent in plain browsers, and any bridge
// failure is swallowed — the notification is a convenience and must never
// break the chat.

export function sendAskCountToShell(count: number): void {
  try {
    const bridge = (window as unknown as {
      ocrDesktop?: { sendAsks?: (n: number) => void };
    }).ocrDesktop;
    bridge?.sendAsks?.(count);
  } catch {
    // no shell, or the bridge rejected — the toast is best-effort
  }
}
