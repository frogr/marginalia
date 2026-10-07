// The twelve books in the corpus, with the rules needed to find chapter
// boundaries in each Project Gutenberg plain-text file. Every Gutenberg file
// has its own front matter, table of contents and heading style, so the rules
// are per book and `npm run corpus` checks the chapter counts against
// `expectedChapters` so a silent parsing regression fails loudly.

export interface BookSpec {
  gutenbergId: number;
  slug: string;
  title: string;
  author: string;
  translator?: string;
  year: number;
  /** Short names people use in questions ("Gatsby", "Moby-Dick"). Lowercase. */
  aliases: string[];
  /** First body line. `occurrence` is 1-based among lines matching `re`. */
  start: { re: RegExp; occurrence?: number };
  /** A chapter heading line (tested against the trimmed line). */
  heading: RegExp;
  /** A part / book / volume heading (tested against the trimmed line). */
  part?: RegExp;
  /** The next non-blank line after a heading is the chapter's title. */
  titleNext?: boolean;
  /** Stop before the first line (trimmed) matching this, after the start. */
  end?: RegExp;
  expectedChapters: number;
}

export const BOOKS: BookSpec[] = [
  {
    gutenbergId: 1342,
    slug: "pride-and-prejudice",
    title: "Pride and Prejudice",
    author: "Jane Austen",
    year: 1813,
    aliases: ["pride and prejudice", "pride & prejudice"],
    start: { re: /^\[Illustration: ·PRIDE AND PREJUDICE·/ },
    heading: /^(CHAPTER|Chapter) [IVXLC]+\.?\]?$/,
    end: /^THE$/,
    expectedChapters: 61,
  },
  {
    gutenbergId: 2701,
    slug: "moby-dick",
    title: "Moby-Dick",
    author: "Herman Melville",
    year: 1851,
    aliases: ["moby dick", "moby-dick", "the whale"],
    start: { re: /^CHAPTER 1\. Loomings\.$/, occurrence: 2 },
    heading: /^(CHAPTER \d+\. .+|Epilogue)$/,
    expectedChapters: 136,
  },
  {
    gutenbergId: 84,
    slug: "frankenstein",
    title: "Frankenstein",
    author: "Mary Shelley",
    year: 1818,
    aliases: ["frankenstein"],
    start: { re: /^Letter 1$/ },
    heading: /^(Letter \d+|Chapter \d+)$/,
    expectedChapters: 28,
  },
  {
    gutenbergId: 345,
    slug: "dracula",
    title: "Dracula",
    author: "Bram Stoker",
    year: 1897,
    aliases: ["dracula"],
    start: { re: /^CHAPTER I$/ },
    heading: /^CHAPTER [IVXL]+$/,
    titleNext: true,
    end: /^THE END$/,
    expectedChapters: 27,
  },
  {
    gutenbergId: 1260,
    slug: "jane-eyre",
    title: "Jane Eyre",
    author: "Charlotte Brontë",
    year: 1847,
    aliases: ["jane eyre"],
    start: { re: /^CHAPTER I$/ },
    heading: /^CHAPTER [IVXL]+(—CONCLUSION)?$/,
    expectedChapters: 38,
  },
  {
    gutenbergId: 1400,
    slug: "great-expectations",
    title: "Great Expectations",
    author: "Charles Dickens",
    year: 1861,
    aliases: ["great expectations"],
    start: { re: /^Chapter I\.$/ },
    heading: /^Chapter [IVXL]+\.$/,
    expectedChapters: 59,
  },
  {
    gutenbergId: 64317,
    slug: "the-great-gatsby",
    title: "The Great Gatsby",
    author: "F. Scott Fitzgerald",
    year: 1925,
    aliases: ["great gatsby", "the great gatsby"],
    start: { re: /^\s+I$/ },
    heading: /^[IVX]+$/,
    expectedChapters: 9,
  },
  {
    gutenbergId: 11,
    slug: "alice-in-wonderland",
    title: "Alice's Adventures in Wonderland",
    author: "Lewis Carroll",
    year: 1865,
    aliases: ["alice in wonderland", "alice's adventures in wonderland", "wonderland"],
    start: { re: /^CHAPTER I\.$/ },
    heading: /^CHAPTER [IVXL]+\.$/,
    titleNext: true,
    end: /^THE END$/,
    expectedChapters: 12,
  },
  {
    gutenbergId: 174,
    slug: "the-picture-of-dorian-gray",
    title: "The Picture of Dorian Gray",
    author: "Oscar Wilde",
    year: 1890,
    aliases: ["dorian gray", "the picture of dorian gray"],
    start: { re: /^CHAPTER I\.$/ },
    heading: /^CHAPTER [IVXL]+\.$/,
    end: /^THE END$/,
    expectedChapters: 20,
  },
  {
    gutenbergId: 2554,
    slug: "crime-and-punishment",
    title: "Crime and Punishment",
    author: "Fyodor Dostoyevsky",
    translator: "Constance Garnett",
    year: 1866,
    aliases: ["crime and punishment"],
    start: { re: /^PART I$/ },
    part: /^(PART [IVX]+|EPILOGUE)$/,
    // The epilogue's two sections are headed by a bare "I" and "II".
    heading: /^(CHAPTER [IVXL]+|I|II)$/,
    expectedChapters: 41,
  },
  {
    gutenbergId: 98,
    slug: "a-tale-of-two-cities",
    title: "A Tale of Two Cities",
    author: "Charles Dickens",
    year: 1859,
    aliases: ["a tale of two cities", "tale of two cities"],
    start: { re: /^Book the First--Recalled to Life$/ },
    part: /^Book the (First|Second|Third)--.+$/,
    heading: /^CHAPTER [IVXL]+\.$/,
    titleNext: true,
    expectedChapters: 45,
  },
  {
    gutenbergId: 514,
    slug: "little-women",
    title: "Little Women",
    author: "Louisa May Alcott",
    year: 1868,
    aliases: ["little women"],
    start: { re: /^PART 1$/ },
    part: /^PART \d$/,
    heading: /^CHAPTER [A-Z-]+$/,
    titleNext: true,
    expectedChapters: 47,
  },
];

export const BOOK_BY_SLUG = new Map(BOOKS.map((b) => [b.slug, b]));
