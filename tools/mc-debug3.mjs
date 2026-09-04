import { chromium } from "playwright-core";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = browser.contexts()[0].pages().find(p => p.url().includes("index.html")) ?? browser.contexts()[0].pages()[0];
for (const f of page.frames()) {
  let body = "", err = "";
  try { body = (await f.evaluate(() => document.body?.innerText.slice(0, 80) ?? "")) ?? ""; } catch (e) { err = String(e).slice(0, 80); }
  console.log(`frame: url=${f.url().slice(0, 70)} | err=${err} | body=${body.replace(/\n/g, " ").slice(0, 60)}`);
}
process.exit(0);
