// npm run build && npm run screenshots
//
// Starts the built server on a spare port, drives it with Playwright and
// saves docs/screenshots/*.png. Uses a preinstalled Chromium when
// CHROMIUM_PATH is set or one is found under PLAYWRIGHT_BROWSERS_PATH.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(ROOT, "docs/screenshots");
const PORT = 3999;
const BASE = `http://localhost:${PORT}`;

function findChromium(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const dir = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  if (!existsSync(dir)) return undefined;
  for (const d of readdirSync(dir).filter((d) => d.startsWith("chromium-"))) {
    const p = join(dir, d, "chrome-linux", "chrome");
    if (existsSync(p)) return p;
  }
  return undefined;
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not start");
}

async function ask(page: Page, q: string) {
  await page.goto(`${BASE}/?q=${encodeURIComponent(q)}`);
  await page.waitForSelector(".answer");
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const server = spawn("node", ["dist/src/server/index.js"], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" }, stdio: "inherit" });
  try {
    await waitForServer();
    const browser = await chromium.launch({ executablePath: findChromium() });
    const desktop = await browser.newPage({ viewport: { width: 1280, height: 800 } });

    await desktop.goto(BASE);
    await desktop.screenshot({ path: join(OUT, "home.png") });

    await ask(desktop, "What did the Queen use for croquet mallets and balls?");
    await desktop.click(".cite");
    await desktop.waitForSelector(".expand:not([hidden]) mark");
    await desktop.screenshot({ path: join(OUT, "answer.png") });

    await desktop.click(".how summary");
    await desktop.evaluate(() => document.querySelector(".how")!.scrollIntoView());
    await desktop.screenshot({ path: join(OUT, "how-it-was-made.png") });

    await desktop.goto(`${BASE}/read/the-great-gatsby/5?from=121&to=122#p121`);
    await desktop.screenshot({ path: join(OUT, "reader.png") });

    const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await ask(phone, "At what time had Miss Havisham's clocks stopped?");
    await phone.click(".cite");
    await phone.waitForSelector(".expand:not([hidden]) mark");
    await phone.evaluate(() => document.querySelector(".answer")!.scrollIntoView());
    await phone.screenshot({ path: join(OUT, "phone.png") });

    await browser.close();
    console.log(`saved screenshots to ${OUT}`);
  } finally {
    server.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
