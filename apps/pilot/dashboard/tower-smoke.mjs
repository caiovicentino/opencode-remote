// smoke headless: abre ?mock=1 via file://, coleta erros de console, tira shots
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
const url = new URL("./index.html", import.meta.url).href + "?mock=1&speed=4";
const outDir = new URL("./.shots/", import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });
let browser;
try { browser = await chromium.launch({ headless: true }); }
catch { browser = await chromium.launch({ headless: true, channel: "chrome" }); }
const errors = [];
async function run(w, h, name, waitMs, reduced) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: reduced ? "reduce" : "no-preference", colorScheme: "dark" });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") errors.push(`[${name}] ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`[${name}] pageerror ${e.message}`));
  await page.goto(url);
  await page.waitForTimeout(waitMs);
  const info = await page.evaluate(() => ({
    flights: document.querySelectorAll(".flight").length,
    active: document.querySelectorAll(".flight.active").length,
    transcript: document.querySelectorAll("#transcript .ln").length,
    chips: document.querySelectorAll("#transcript .chip").length,
    lamps: document.querySelectorAll(".lamp.ok, .lamp.fail, .lamp.running").length,
    findings: document.querySelectorAll(".finding").length,
    dropped: document.querySelectorAll(".finding.dropped").length,
    beats: document.querySelectorAll(".ecg-wrap .beat").length,
    presence: document.querySelectorAll(".pres").length,
    thinking: document.querySelectorAll(".pres.thinking, .pres.tool").length,
    queue: document.querySelectorAll(".qrow").length,
    conn: document.getElementById("conn-text").textContent,
    tplus: document.getElementById("ck-tplus").textContent,
  }));
  console.log(name, JSON.stringify(info));
  await page.screenshot({ path: `${outDir}${name}.png` });
  if (name === "desktop") {
    await page.keyboard.press("d"); await page.waitForTimeout(500);
    await page.screenshot({ path: `${outDir}${name}-dossier.png` });
    await page.keyboard.press("Escape"); await page.keyboard.press("l"); await page.waitForTimeout(400);
    await page.screenshot({ path: `${outDir}${name}-logs.png` });
    await page.keyboard.press("Escape");
    await page.click("#btn-budget"); await page.waitForTimeout(300);
    await page.screenshot({ path: `${outDir}${name}-budget.png` });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(25000);
    const late = await page.evaluate(() => ({ beats: document.querySelectorAll(".ecg-wrap .beat").length, prod: document.querySelectorAll(".runway .sha.live").length, landed: document.querySelectorAll(".flight.landed, .flight.failed").length, ticker: document.getElementById("ticker-line").textContent.slice(0, 120) }));
    console.log("desktop-late", JSON.stringify(late));
    await page.screenshot({ path: `${outDir}${name}-late.png` });
  }
  await ctx.close();
}
await run(1440, 900, "desktop", 14000, false);
await run(390, 844, "phone", 9000, false);
await run(1440, 900, "reduced", 6000, true);
await browser.close();
console.log("console errors:", errors.length ? errors.join("\n") : "none");
process.exit(errors.length ? 1 : 0);
