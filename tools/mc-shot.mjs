import { chromium } from "playwright-core";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = browser.contexts()[0].pages().find(p => p.url().includes("index.html")) ?? browser.contexts()[0].pages()[0];
await page.screenshot({ path: "/tmp/mc-final.png" });
process.exit(0);
