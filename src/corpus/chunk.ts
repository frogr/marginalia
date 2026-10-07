// Turns parsed chapters into overlapping, paragraph-based retrieval chunks.
//
// A chunk never crosses a chapter boundary. Paragraphs are added to a window
// until it reaches `targetWords`; the next window starts with the last
// paragraph of the previous one (when that paragraph is short enough), so a
// passage that sits on a boundary is still whole in at least one chunk.
// Paragraphs longer than `maxWords` (Melville has many) are split at sentence
// ends into pieces of roughly `targetWords`.
//
// Offsets: `charStart`/`charEnd` index into the chapter text, which is the
// chapter's paragraphs joined with "\n\n" (see `chapterText`). The chunk text
// is exactly `chapterText(chapter).slice(charStart, charEnd)`.

export interface CorpusParagraph {
  text: string;
  line: number;
}
export interface CorpusChapter {
  index: number;
  title: string;
  paragraphs: CorpusParagraph[];
}
export interface CorpusBook {
  gutenbergId: number;
  slug: string;
  title: string;
  author: string;
  translator?: string;
  year: number;
  aliases: string[];
  sourceUrl: string;
  chapters: CorpusChapter[];
}

export interface Chunk {
  /** Stable id: `<slug>:<chapter index>:<n>` */
  id: string;
  book: string;
  chapter: number;
  chapterTitle: string;
  /** First and last paragraph index (inclusive) within the chapter. */
  paraStart: number;
  paraEnd: number;
  charStart: number;
  charEnd: number;
  /** Line in the Gutenberg file where the chunk's first paragraph starts. */
  line: number;
  text: string;
}

export interface ChunkOptions {
  targetWords: number;
  maxWords: number;
  /** Repeat the previous window's last paragraph if it has at most this many words. */
  overlapMaxWords: number;
}

// Chosen with `npm run eval`: 240-word windows beat 160 and 100 (see PROOF.md).
export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { targetWords: 240, maxWords: 360, overlapMaxWords: 120 };
export const SMALL_CHUNK_OPTIONS: ChunkOptions = { targetWords: 160, maxWords: 260, overlapMaxWords: 90 };

export const PARAGRAPH_SEPARATOR = "\n\n";

export function chapterText(ch: CorpusChapter): string {
  return ch.paragraphs.map((p) => p.text).join(PARAGRAPH_SEPARATOR);
}

const wordCount = (s: string) => (s.match(/\S+/g) ?? []).length;

/** A unit is a whole paragraph or a sentence-aligned piece of a long one. */
interface Unit {
  para: number;
  start: number; // offset in chapter text
  end: number;
  words: number;
}

// Words that end in a period without ending a sentence ("Mr. Darcy").
const ABBREVIATIONS = new Set(["mr", "mrs", "messrs", "dr", "st", "mme", "mlle", "m", "capt", "col", "gen", "rev", "esq", "no", "vol", "ch", "jr", "sr"]);

/** Sentence-ish split points: after . ! ? (optionally followed by a closing quote) and a space. */
export function sentenceSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  const re = /[.!?]+["”’)]*\s+(?=["“‘(]?[A-Z0-9])/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const before = /([A-Za-z]+)$/.exec(text.slice(Math.max(start, m.index - 12), m.index));
    if (m[0].startsWith(".") && before && (ABBREVIATIONS.has(before[1].toLowerCase()) || before[1].length === 1)) continue;
    const end = m.index + m[0].trimEnd().length;
    spans.push([start, end]);
    start = m.index + m[0].length;
  }
  if (start < text.length) spans.push([start, text.length]);
  return spans;
}

function units(ch: CorpusChapter, opts: ChunkOptions): Unit[] {
  const out: Unit[] = [];
  let offset = 0;
  ch.paragraphs.forEach((p, para) => {
    const words = wordCount(p.text);
    if (words <= opts.maxWords) {
      out.push({ para, start: offset, end: offset + p.text.length, words });
    } else {
      let pieceStart = -1;
      let pieceEnd = 0;
      let pieceWords = 0;
      for (const [s, e] of sentenceSpans(p.text)) {
        if (pieceStart < 0) pieceStart = s;
        pieceEnd = e;
        pieceWords += wordCount(p.text.slice(s, e));
        if (pieceWords >= opts.targetWords) {
          out.push({ para, start: offset + pieceStart, end: offset + pieceEnd, words: pieceWords });
          pieceStart = -1;
          pieceWords = 0;
        }
      }
      if (pieceStart >= 0) out.push({ para, start: offset + pieceStart, end: offset + pieceEnd, words: pieceWords });
    }
    offset += p.text.length + PARAGRAPH_SEPARATOR.length;
  });
  return out;
}

export function chunkChapter(slug: string, ch: CorpusChapter, opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS): Chunk[] {
  const text = chapterText(ch);
  const us = units(ch, opts);
  const chunks: Chunk[] = [];
  let i = 0;
  while (i < us.length) {
    let j = i;
    let words = us[i].words;
    while (j + 1 < us.length && words < opts.targetWords && words + us[j + 1].words <= opts.maxWords) {
      j++;
      words += us[j].words;
    }
    const first = us[i];
    const last = us[j];
    chunks.push({
      id: `${slug}:${ch.index}:${chunks.length}`,
      book: slug,
      chapter: ch.index,
      chapterTitle: ch.title,
      paraStart: first.para,
      paraEnd: last.para,
      charStart: first.start,
      charEnd: last.end,
      line: ch.paragraphs[first.para].line,
      text: text.slice(first.start, last.end),
    });
    if (j + 1 >= us.length) break;
    // Overlap: start the next window on this window's last unit if it is short
    // and the window holds more than one unit (otherwise we would never advance).
    i = j > i && us[j].words <= opts.overlapMaxWords ? j : j + 1;
  }
  return chunks;
}

export function chunkBook(book: CorpusBook, opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS): Chunk[] {
  return book.chapters.flatMap((ch) => chunkChapter(book.slug, ch, opts));
}
