import type { CorpusBook } from "../src/corpus/chunk.js";

const book = (slug: string, title: string, chapters: string[][]): CorpusBook => ({
  gutenbergId: 0,
  slug,
  title,
  author: "Test Author",
  year: 1900,
  aliases: [title.toLowerCase()],
  sourceUrl: "https://example.org",
  chapters: chapters.map((paras, index) => ({ index, title: `Chapter ${index + 1}`, paragraphs: paras.map((text, i) => ({ text, line: i * 2 + 1 })) })),
});

/** Two tiny books, small enough to reason about by hand. */
export const TINY: CorpusBook[] = [
  book("whales", "The Whale Book", [
    [
      "Call me Ishmael. Some years ago I went to sea on a whaling ship.",
      "The captain hunted the white whale across every ocean.",
      "The whale was white, and the captain was angry.",
    ],
    ["The harpooner slept in my bed at the inn.", "In the morning we walked to the harbour together."],
  ]),
  book("manners", "The Manners Book", [
    [
      "It is a truth universally acknowledged that a rich man wants a wife.",
      "Elizabeth walked three miles through the mud to see her sister.",
      "Mr. Darcy said she was tolerable, but not handsome enough to tempt him.",
    ],
  ]),
];
