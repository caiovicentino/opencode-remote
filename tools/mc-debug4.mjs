import { chromium } from "playwright-core";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = browser.contexts()[0].pages().find(p => p.url().includes("index.html")) ?? browser.contexts()[0].pages()[0];
const frame = page.frames().find(f => f.url().includes("dashboard") || f.url().includes("8792"));
if (!frame) { console.log("no dashboard frame"); process.exit(0); }
const styles = await frame.evaluate(() => {
  const b = document.body;
  const cs = getComputedStyle(b);
  return { bg: cs.backgroundColor, color: cs.color, htmlBg: getComputedStyle(document.documentElement).backgroundColor, text: document.body.innerText.slice(0, 40) };
});
console.log("iframe styles:", JSON.stringify(styles));
const el = await frame.frameElement();
await el.screenshot({ path: "/tmp/mc-iframe.png" });
console.log("element shot ok");
process.exit(0);
