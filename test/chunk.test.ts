import { describe, expect, it } from "vitest";
import { chapterText, chunkBook, chunkChapter, sentenceSpans, type CorpusChapter } from "../src/corpus/chunk.js";
import { TINY } from "./fixtures.js";

const words = (n: number, w = "word") => Array.from({ length: n }, () => w).join(" ");
const chapter = (paras: string[]): CorpusChapter => ({ index: 0, title: "Chapter 1", paragraphs: paras.map((text, i) => ({ text, line: i + 1 })) });

describe("chunkChapter", () => {
  it("keeps exact character offsets into the chapter text", () => {
    for (const b of TINY) {
      for (const ch of b.chapters) {
        const text = chapterText(ch);
        for (const c of chunkChapter(b.slug, ch)) expect(text.slice(c.charStart, c.charEnd)).toBe(c.text);
      }
    }
  });

  it("never crosses a chapter boundary", () => {
    const chunks = chunkBook(TINY[0]);
    expect(chunks.map((c) => c.chapter)).toEqual([0, 1]);
    expect(chunks[1].text.startsWith("The harpooner")).toBe(true);
  });

  it("fills windows to the target size and overlaps by one short paragraph", () => {
    const ch = chapter([words(60, "a"), words(60, "b"), words(60, "c"), words(60, "d"), words(60, "e")]);
    const chunks = chunkChapter("x", ch, { targetWords: 100, maxWords: 200, overlapMaxWords: 80 });
    expect(chunks.map((c) => [c.paraStart, c.paraEnd])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
    ]);
  });

  it("does not repeat a paragraph that is too long to overlap", () => {
    const ch = chapter([words(60, "a"), words(90, "b"), words(60, "c")]);
    const chunks = chunkChapter("x", ch, { targetWords: 100, maxWords: 200, overlapMaxWords: 80 });
    expect(chunks.map((c) => [c.paraStart, c.paraEnd])).toEqual([
      [0, 1],
      [2, 2],
    ]);
  });

  it("splits a very long paragraph at sentence ends", () => {
    const sentence = `Word ${words(28)} end.`;
    const long = Array.from({ length: 20 }, () => sentence).join(" ");
    const ch = chapter([long]);
    const chunks = chunkChapter("x", ch, { targetWords: 100, maxWords: 150, overlapMaxWords: 50 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.text.endsWith("end.")).toBe(true);
      expect(c.text.split(" ").length).toBeLessThanOrEqual(150);
      expect(chapterText(ch).slice(c.charStart, c.charEnd)).toBe(c.text);
    }
  });

  it("gives every chunk a stable id and source line", () => {
    const chunks = chunkBook(TINY[1]);
    expect(chunks[0].id).toBe("manners:0:0");
    expect(chunks[0].line).toBe(1);
  });
});

describe("sentenceSpans", () => {
  it("splits on sentence ends but not on titles like Mr.", () => {
    const t = "Mr. Darcy bowed. “Are you well?” she asked. He was. Then St. Paul’s bell rang.";
    const s = sentenceSpans(t).map(([a, b]) => t.slice(a, b));
    expect(s).toEqual(["Mr. Darcy bowed.", "“Are you well?” she asked.", "He was.", "Then St. Paul’s bell rang."]);
  });
});
