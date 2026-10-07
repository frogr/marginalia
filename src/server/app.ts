import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { Asker, MAX_QUESTION_CHARS, readUrl } from "../answer/ask.js";
import { ROOT } from "../library.js";
import { RateLimiter } from "./rate-limit.js";
import { renderChapter } from "./reader.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/** The public/ folder is small, so it is read once into memory. */
function loadStatic(dir = join(ROOT, "public")) {
  const files = new Map<string, { body: Buffer; type: string }>();
  for (const f of readdirSync(dir)) {
    const type = TYPES[extname(f)];
    if (type) files.set(`/${f}`, { body: readFileSync(join(dir, f)), type });
  }
  return files;
}

function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (fwd) return fwd;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown"; // app.request() in tests has no socket
  }
}

export function createApp(asker: Asker, opts: { limiter?: RateLimiter } = {}) {
  const { lib, cfg } = asker;
  const limiter = opts.limiter ?? new RateLimiter(cfg.askPerMinute, 60_000);
  const statics = loadStatic();
  const app = new Hono();

  app.use(
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
      },
    }),
  );

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "Something went wrong on our side." }, 500);
  });

  app.get("/health", (c) =>
    c.json({
      ok: true,
      books: lib.books.size,
      chunks: lib.chunks.length,
      retrieval: asker.retrievalMethod,
      answers: asker.model ? `model (${asker.model.name})` : "extractive",
      modelCallsToday: asker.budget.used,
      dailyLlmLimit: asker.budget.limit,
    }),
  );

  app.get("/api/books", (c) => c.json({ books: lib.bookInfo().map(({ chapters, ...b }) => ({ ...b, chapters: chapters.length })) }));

  app.post("/api/ask", bodyLimit({ maxSize: 4096, onError: (c) => c.json({ error: "Request too large." }, 413) }), async (c) => {
    const wait = limiter.hit(clientIp(c, cfg.trustProxy));
    if (wait) {
      c.header("Retry-After", String(wait));
      return c.json({ error: `Too many questions. Try again in ${wait} seconds.` }, 429);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Send JSON: {\"question\": \"...\"}." }, 400);
    }
    const { question, books } = (body ?? {}) as { question?: unknown; books?: unknown };
    if (typeof question !== "string" || question.trim().length < 3) return c.json({ error: "Ask a question of at least a few words." }, 400);
    if (question.length > MAX_QUESTION_CHARS) return c.json({ error: `Questions are limited to ${MAX_QUESTION_CHARS} characters.` }, 400);
    if (books !== undefined && (!Array.isArray(books) || books.length > lib.books.size || books.some((b) => typeof b !== "string" || !lib.books.has(b)))) {
      return c.json({ error: "Unknown book in filter." }, 400);
    }
    return c.json(await asker.ask({ question: question.trim(), books: books as string[] | undefined }));
  });

  app.get("/api/passage", (c) => {
    const id = c.req.query("id") ?? "";
    const chunk = lib.chunkById.get(id);
    if (!chunk) return c.json({ error: "No passage with that id." }, 404);
    const paras = lib.books.get(chunk.book)!.chapters[chunk.chapter].paragraphs;
    return c.json({
      id: chunk.id,
      book: chunk.book,
      bookTitle: lib.books.get(chunk.book)!.title,
      chapter: chunk.chapter,
      chapterTitle: chunk.chapterTitle,
      paraStart: chunk.paraStart,
      paraEnd: chunk.paraEnd,
      charStart: chunk.charStart,
      charEnd: chunk.charEnd,
      line: chunk.line,
      text: chunk.text,
      before: paras[chunk.paraStart - 1]?.text ?? null,
      after: paras[chunk.paraEnd + 1]?.text ?? null,
      readUrl: readUrl(chunk.book, chunk.chapter, chunk.paraStart, chunk.paraEnd),
    });
  });

  app.get("/read/:book/:chapter", (c) => {
    const n = (v: string | undefined) => {
      const x = Number.parseInt(v ?? "", 10);
      return Number.isFinite(x) && x > 0 ? x : undefined;
    };
    const html = renderChapter(lib, c.req.param("book"), n(c.req.param("chapter")) ?? 0, n(c.req.query("from")), n(c.req.query("to")));
    return html ? c.html(html) : c.text("Chapter not found.", 404);
  });

  app.get("*", (c) => {
    const path = c.req.path === "/" ? "/index.html" : c.req.path;
    const f = statics.get(path);
    if (!f) return c.text("Not found.", 404);
    return c.body(new Uint8Array(f.body), 200, { "content-type": f.type, "cache-control": "public, max-age=300" });
  });

  return app;
}
