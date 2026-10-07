// Downloads the twelve books from Project Gutenberg, strips the license
// header/footer, splits chapters and paragraphs, and writes
// data/corpus/<slug>.json plus data/books.json.
//
//   npm run corpus            # uses data/raw/ cache when present
//   npm run corpus -- --fresh # re-download everything
//
// Book URLs are looked up on gutendex.com (a JSON API over the Gutenberg
// catalog). If gutendex is slow or down we fall back to Gutenberg's own
// stable /ebooks/<id>.txt.utf-8 URL.
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { BOOKS } from "../src/corpus/books.js";
import { parseBook } from "../src/corpus/parse.js";

const ROOT = new URL("..", import.meta.url).pathname;
const RAW = join(ROOT, "data/raw");
const OUT = join(ROOT, "data/corpus");
const fresh = process.argv.includes("--fresh");

async function exists(p: string) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function fetchText(url: string, tries = 4): Promise<string> {
  let lastErr: unknown;
  for (let t = 0; t < tries; t++) {
    try {
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(90_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500 * (t + 1)));
    }
  }
  throw lastErr;
}

async function gutendexUrls(): Promise<Map<number, string>> {
  const missing = [];
  for (const b of BOOKS) if (fresh || !(await exists(join(RAW, `${b.gutenbergId}.txt`)))) missing.push(b);
  if (!missing.length) return new Map(); // everything is cached, no network needed
  const ids = BOOKS.map((b) => b.gutenbergId).join(",");
  const map = new Map<number, string>();
  try {
    const res = await fetch(`https://gutendex.com/books/?ids=${ids}`, { signal: AbortSignal.timeout(15_000) });
    const json = (await res.json()) as { results: { id: number; formats: Record<string, string> }[] };
    for (const r of json.results) {
      const url = r.formats["text/plain; charset=utf-8"] ?? r.formats["text/plain; charset=us-ascii"];
      if (url) map.set(r.id, url);
    }
    console.log(`gutendex: found plain-text URLs for ${map.size} books`);
  } catch (e) {
    console.warn(`gutendex lookup failed (${(e as Error).message}); using default Gutenberg URLs`);
  }
  return map;
}

async function main() {
  await mkdir(RAW, { recursive: true });
  await mkdir(OUT, { recursive: true });
  const urls = await gutendexUrls();
  const summary = [];
  let failures = 0;

  for (const spec of BOOKS) {
    const rawPath = join(RAW, `${spec.gutenbergId}.txt`);
    const url = urls.get(spec.gutenbergId) ?? `https://www.gutenberg.org/ebooks/${spec.gutenbergId}.txt.utf-8`;
    let raw: string;
    if (!fresh && (await exists(rawPath))) {
      raw = await readFile(rawPath, "utf8");
    } else {
      process.stdout.write(`downloading ${spec.title} ... `);
      raw = await fetchText(url);
      await writeFile(rawPath, raw);
      console.log(`${(raw.length / 1024).toFixed(0)} KB`);
    }

    const parsed = parseBook(raw, spec);
    const paragraphs = parsed.chapters.reduce((n, c) => n + c.paragraphs.length, 0);
    const words = parsed.chapters.reduce((n, c) => n + c.paragraphs.reduce((m, p) => m + p.text.split(" ").length, 0), 0);
    const ok = parsed.chapters.length === spec.expectedChapters;
    if (!ok) failures++;
    console.log(
      `${ok ? "ok  " : "FAIL"} ${spec.slug.padEnd(28)} chapters=${parsed.chapters.length}/${spec.expectedChapters} paragraphs=${paragraphs} words=${words}`,
    );

    const { start, heading, part, end, titleNext, expectedChapters, ...meta } = spec;
    void start, heading, part, end, titleNext, expectedChapters;
    const book = { ...meta, sourceUrl: url, chapters: parsed.chapters };
    await writeFile(join(OUT, `${spec.slug}.json`), JSON.stringify(book));
    summary.push({ slug: spec.slug, title: spec.title, chapters: parsed.chapters.length, paragraphs, words });
  }

  await writeFile(join(ROOT, "data/books.json"), JSON.stringify(summary, null, 2) + "\n");
  if (failures) {
    console.error(`${failures} book(s) had unexpected chapter counts`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
