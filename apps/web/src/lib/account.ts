/**
 * P2-124: sidebar account footer helpers — pure and unit-tested so the
 * gate can pin the avatar/plan behavior without a live UI.
 */

/** First letter/digit of the machine name, uppercased ("caio-mbp" → "C").
 * Names without any letter or digit fall back to "" (avatar shows a glyph). */
export function accountInitial(name: string): string {
  const match = name.trim().match(/\p{L}|\p{N}/u);
  return match ? match[0].toLocaleUpperCase() : "";
}

/** The "plan" line is just the connection mode (constitution 7: no ceremony). */
export function accountPlanKey(localMode: boolean): "planLocal" | "planRemote" {
  return localMode ? "planLocal" : "planRemote";
}
