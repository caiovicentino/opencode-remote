import { chromium } from "playwright-core";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = browser.contexts()[0].pages().find(p => p.url().includes("index.html")) ?? browser.contexts()[0].pages()[0];
page.on("console", m => { if (m.type() === "error") console.log("CONSOLE ERR:", m.text().slice(0, 120)); });
await page.click("text=Mission Control", { timeout: 5000 }).catch(e => console.log("click fail:", String(e).slice(0, 80)));
await page.waitForTimeout(6000);
const info = await page.evaluate(() => {
  const f = document.querySelector(".mission iframe");
  return {
    iframe: f ? { src: f.src.slice(0, 80), w: f.clientWidth, h: f.clientHeight } : null,
    missionChildren: document.querySelector(".mission")?.children.length ?? -1,
  };
});
console.log("info:", JSON.stringify(info));
await page.screenshot({ path: "/tmp/mc-pane2.png" });
process.exit(0);
