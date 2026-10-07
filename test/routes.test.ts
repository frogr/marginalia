// Route tests run against the real twelve-book corpus (no network needed).
import { beforeAll, describe, expect, it } from "vitest";
import { Asker, DailyCounter } from "../src/answer/ask.js";
import { loadConfig } from "../src/config.js";
import { UpstreamError } from "../src/http.js";
import { Library } from "../src/library.js";
import { createApp } from "../src/server/app.js";
import { RateLimiter } from "../src/server/rate-limit.js";

let lib: Library;
beforeAll(() => {
  lib = Library.fromDir();
});

const cfg = loadConfig({});
const post = (app: ReturnType<typeof createApp>, body: unknown, headers: Record<string, string> = {}) =>
  app.request("/api/ask", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("routes", () => {
  it("GET /health reports the corpus and mode", async () => {
    const app = createApp(new Asker(lib, cfg));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, books: 12, retrieval: "bm25", answers: "extractive" });
  });

  it("POST /api/ask answers extractively with every quote verified", async () => {
    const app = createApp(new Asker(lib, cfg));
    const res = await post(app, { question: "What words were marked on the little cake Alice found?" });
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.answer.mode).toBe("extractive");
    expect(d.answer.total).toBeGreaterThan(0);
    expect(d.answer.verified).toBe(d.answer.total);
    expect(d.retrieval.passages[0].book).toBe("alice-in-wonderland");
    expect(d.answer.claims.some((c: { text: string }) => c.text.includes("EAT ME"))).toBe(true);
    expect(d.retrieval.passages[0].readUrl).toMatch(/^\/read\/alice-in-wonderland\/\d+\?from=\d+&to=\d+#p\d+$/);
  });

  it("applies the book filter", async () => {
    const app = createApp(new Asker(lib, cfg));
    const d = await (await post(app, { question: "the captain and the ship", books: ["frankenstein"] })).json();
    expect(d.retrieval.passages.every((p: { book: string }) => p.book === "frankenstein")).toBe(true);
  });

  it("rejects bad input", async () => {
    const app = createApp(new Asker(lib, cfg));
    expect((await post(app, "not json")).status).toBe(400);
    expect((await post(app, { question: "hi" })).status).toBe(400);
    expect((await post(app, { question: "x".repeat(401) })).status).toBe(400);
    expect((await post(app, { question: "who is the captain", books: ["not-a-book"] })).status).toBe(400);
    expect((await post(app, { question: "who is the captain", books: "dracula" })).status).toBe(400);
    expect((await post(app, { question: "y".repeat(5000) })).status).toBe(413);
  });

  it("rate limits per client", async () => {
    const app = createApp(new Asker(lib, { ...cfg, trustProxy: true }), { limiter: new RateLimiter(2, 60_000) });
    const a = { "x-forwarded-for": "1.1.1.1" };
    expect((await post(app, { question: "white whale" }, a)).status).toBe(200);
    expect((await post(app, { question: "white whale" }, a)).status).toBe(200);
    const blocked = await post(app, { question: "white whale" }, a);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    expect((await post(app, { question: "white whale" }, { "x-forwarded-for": "2.2.2.2" })).status).toBe(200);
  });

  it("falls back to extractive with a plain notice when the model fails", async () => {
    const model = { provider: "anthropic" as const, name: "test-model", call: async () => Promise.reject(new UpstreamError("rate_limit", "Anthropic", 429)) };
    const app = createApp(new Asker(lib, cfg, { model }));
    const d = await (await post(app, { question: "What did the Queen use for croquet mallets?" })).json();
    expect(d.answer.mode).toBe("extractive");
    expect(d.answer.notice).toMatch(/rate limiting/);
    expect(JSON.stringify(d)).not.toMatch(/HTTP 429|stack/);
  });

  it("stops calling the model when the daily cap is reached", async () => {
    let calls = 0;
    const model = {
      provider: "anthropic" as const,
      name: "test-model",
      call: async () => {
        calls++;
        return JSON.stringify({ not_found: true, answer: [] });
      },
    };
    const app = createApp(new Asker(lib, cfg, { model, budget: new DailyCounter(1) }));
    const first = await (await post(app, { question: "What did the Queen use for croquet mallets?" })).json();
    expect(first.answer.mode).toBe("model");
    const second = await (await post(app, { question: "What did the Queen use for croquet mallets?" })).json();
    expect(second.answer.mode).toBe("extractive");
    expect(second.answer.notice).toMatch(/budget/);
    expect(calls).toBe(1);
  });

  it("GET /api/passage returns a chunk with context, or 404", async () => {
    const app = createApp(new Asker(lib, cfg));
    const id = lib.chunks.find((c) => c.book === "dracula" && c.paraStart > 0)!.id;
    const res = await app.request(`/api/passage?id=${encodeURIComponent(id)}`);
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d).toMatchObject({ id, book: "dracula", bookTitle: "Dracula" });
    expect(typeof d.before).toBe("string");
    expect((await app.request("/api/passage?id=nope")).status).toBe(404);
  });

  it("GET /read renders a chapter with the cited paragraphs marked", async () => {
    const app = createApp(new Asker(lib, cfg));
    const res = await app.request("/read/the-great-gatsby/9?from=2&to=3");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("boats against the current");
    expect(html.match(/class="cited"/g)).toHaveLength(2);
    expect((await app.request("/read/the-great-gatsby/99")).status).toBe(404);
    expect((await app.request("/read/nope/1")).status).toBe(404);
  });

  it("serves the page and static files with security headers", async () => {
    const app = createApp(new Asker(lib, cfg));
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect((await app.request("/app.js")).status).toBe(200);
    expect((await app.request("/../package.json")).status).toBe(404);
  });

  it("serves the design kit and its font with content types", async () => {
    const app = createApp(new Asker(lib, cfg));
    const css = await app.request("/austn-kit.css");
    expect(css.headers.get("content-type")).toMatch(/text\/css/);
    const font = await app.request("/fonts/recursive-latin.woff2");
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/woff2");
  });
});

describe("DailyCounter", () => {
  it("resets at the start of a new UTC day", () => {
    let now = new Date("2026-01-01T23:59:00Z");
    const c = new DailyCounter(1, () => now);
    expect(c.take()).toBe(true);
    expect(c.take()).toBe(false);
    now = new Date("2026-01-02T00:00:01Z");
    expect(c.take()).toBe(true);
  });
});
