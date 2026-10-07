// Loads the processed corpus, chunks it and builds the search indexes. Done once
// at startup; takes a couple of seconds for the twelve books.
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BOOKS } from "./corpus/books.js";
import { chapterText, chunkBook, DEFAULT_CHUNK_OPTIONS, type Chunk, type ChunkOptions, type CorpusBook } from "./corpus/chunk.js";
import { Bm25Index } from "./search/bm25.js";
import { fold } from "./search/tokenize.js";
import { VectorIndex } from "./search/vectors.js";

/** Repo root, from either src/ (tsx) or dist/src/ (compiled). */
export const ROOT = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  return basename(dirname(here)) === "dist" ? join(here, "../..") : join(here, "..");
})();
export const DATA_DIR = join(ROOT, "data");

export interface BookInfo {
  slug: string;
  title: string;
  author: string;
  translator?: string;
  year: number;
  aliases: string[];
  sourceUrl: string;
  chapters: { index: number; title: string }[];
}

export class Library {
  readonly books = new Map<string, CorpusBook>();
  readonly chunks: Chunk[] = [];
  readonly chunkById = new Map<string, Chunk>();
  readonly bm25: Bm25Index;
  vectors?: VectorIndex;
  private readonly chapterTexts = new Map<string, string>();

  constructor(books: CorpusBook[], chunkOptions: ChunkOptions = DEFAULT_CHUNK_OPTIONS) {
    // Keep the order of BOOKS so ids and filters are stable.
    const order = new Map(BOOKS.map((b, i) => [b.slug, i]));
    books.sort((a, b) => (order.get(a.slug) ?? 99) - (order.get(b.slug) ?? 99));
    for (const b of books) {
      this.books.set(b.slug, b);
      for (const c of chunkBook(b, chunkOptions)) {
        this.chunks.push(c);
        this.chunkById.set(c.id, c);
      }
    }
    this.bm25 = new Bm25Index(this.chunks.map((c) => ({ text: c.text, book: c.book, group: `${c.book}:${c.chapter}` })));
  }

  static readBooks(dir = DATA_DIR): CorpusBook[] {
    const corpusDir = join(dir, "corpus");
    return readdirSync(corpusDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(corpusDir, f), "utf8")) as CorpusBook);
  }

  static fromDir(dir = DATA_DIR): Library {
    const lib = new Library(Library.readBooks(dir));
    lib.vectors = VectorIndex.load(join(dir, "embeddings"), lib.chunks.map((c) => c.id));
    return lib;
  }

  bookInfo(): BookInfo[] {
    return [...this.books.values()].map(({ chapters, gutenbergId: _g, ...rest }) => ({
      ...rest,
      chapters: chapters.map((c) => ({ index: c.index, title: c.title })),
    }));
  }

  chapterText(slug: string, chapter: number): string | undefined {
    const key = `${slug}:${chapter}`;
    let t = this.chapterTexts.get(key);
    if (t === undefined) {
      const ch = this.books.get(slug)?.chapters[chapter];
      if (!ch) return undefined;
      t = chapterText(ch);
      this.chapterTexts.set(key, t);
    }
    return t;
  }

  /** Books whose title or alias appears in the question, e.g. "in Moby-Dick". */
  booksNamedIn(question: string): string[] {
    const q = ` ${fold(question).replace(/[^a-z0-9&']+/g, " ")} `;
    const out: string[] = [];
    for (const b of this.books.values()) {
      const names = [b.title, ...b.aliases].map((n) => ` ${fold(n).replace(/[^a-z0-9&']+/g, " ").trim()} `);
      if (names.some((n) => q.includes(n))) out.push(b.slug);
    }
    return out;
  }
}
