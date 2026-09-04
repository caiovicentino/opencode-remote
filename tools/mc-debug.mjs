import { chromium } from "playwright-core";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const ctx = browser.contexts()[0];
const pages = ctx.pages();
console.log("pages:", pages.length);
const page = pages.find(p => p.url().includes("index.html")) ?? pages[0];
console.log("url:", page.url().slice(0, 60));
page.on("console", m => { if (m.type() === "error") console.log("CONSOLE ERR:", m.text().slice(0, 150)); });
page.on("pageerror", e => console.log("PAGE ERR:", String(e).slice(0, 200)));
await page.click("text=Mission Control", { timeout: 5000 }).then(() => console.log("clicked")).catch(e => console.log("click fail:", String(e).slice(0, 100)));
await page.waitForTimeout(2500);
const paneInfo = await page.evaluate(() => {
  const el = document.querySelector(".mission") ?? document.querySelector(".pane") ?? document.querySelector("[class*=pane]");
  const mission = document.querySelector(".mission");
  const r = mission?.getBoundingClientRect();
  return {
    missionExists: !!mission,
    rect: r ? { w: r.width, h: r.height } : null,
    htmlLen: mission?.innerHTML.length ?? 0,
    bodyChildren: document.body.children.length,
  };
});
console.log("pane:", JSON.stringify(paneInfo));
await page.screenshot({ path: "/tmp/mc-pane.png" });
process.exit(0);
