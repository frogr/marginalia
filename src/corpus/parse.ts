import type { BookSpec } from "./books.js";

export interface Paragraph {
  /** Cleaned paragraph text (lines joined, whitespace collapsed, _italics_ markers removed). */
  text: string;
  /** 1-based line number of the paragraph's first line in the Gutenberg file (LF line endings). */
  line: number;
}

export interface Chapter {
  index: number;
  /** Display title, e.g. "Part I · Chapter III" or "Chapter 42: The Whiteness of the Whale". */
  title: string;
  paragraphs: Paragraph[];
}

export interface ParsedBook {
  chapters: Chapter[];
}

const START_MARK = /^\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG EBOOK/i;
const END_MARK = /^\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG EBOOK/i;

/** Remove the Project Gutenberg license header and footer. Returns body lines and the 1-based line number of the first one. */
export function stripGutenberg(raw: string): { lines: string[]; firstLine: number } {
  const all = raw.replace(/\r\n?/g, "\n").replace(/^﻿/, "").split("\n");
  const s = all.findIndex((l) => START_MARK.test(l));
  const e = all.findIndex((l) => END_MARK.test(l));
  if (s < 0 || e < 0 || e <= s) throw new Error("Gutenberg START/END markers not found");
  return { lines: all.slice(s + 1, e), firstLine: s + 2 };
}

export function cleanText(s: string): string {
  return s
    .replace(/_([^_]+)_/g, "$1") // Gutenberg marks italics as _word_
    .replace(/_/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const ROMAN = /^[IVXLC]+$/;

function headingLabel(raw: string): string {
  const t = raw.replace(/\.\]?$/, "").replace(/\s+/g, " ").trim();
  // "CHAPTER 42. The Whiteness of the Whale." -> "Chapter 42: The Whiteness of the Whale"
  const m = /^(CHAPTER|Chapter|Letter) ([\w-]+)\.?\s*(.*)$/.exec(t);
  if (m) {
    const num = m[2];
    const word = m[1] === "Letter" ? "Letter" : "Chapter";
    const n = ROMAN.test(num) || /^\d+$/.test(num) ? num : titleCase(num);
    const rest = titleCase(m[3].replace(/\.$/, "").replace(/^[—-]+/, "").trim());
    return rest ? `${word} ${n}: ${rest}` : `${word} ${n}`;
  }
  if (ROMAN.test(t)) return `Chapter ${t}`;
  return titleCase(t);
}

function titleCase(s: string): string {
  const letters = s.replace(/[^A-Za-z]/g, "");
  const upper = letters.replace(/[^A-Z]/g, "").length;
  if (!letters.length || upper / letters.length < 0.6) return s;
  return s
    .toLowerCase()
    .replace(/(^|[\s\-—“"(])([a-z’'])/g, (_m, a: string, b: string) => a + b.toUpperCase())
    .replace(/’S\b/g, "’s")
    .replace(/--/g, ", ");
}

function partLabel(raw: string): string {
  const t = raw.trim();
  const tale = /^Book the (\w+)--(.+)$/.exec(t);
  if (tale) return `Book the ${tale[1]}`;
  // "PART VI" -> "Part VI" (keep the numeral upper case)
  const numbered = /^([A-Z]+) ([IVXLC]+|\d+)$/.exec(t);
  if (numbered) return `${titleCase(numbered[1])} ${numbered[2]}`;
  return titleCase(t);
}

/**
 * Split a Gutenberg body into chapters and paragraphs using the book's rules.
 * Paragraphs are blank-line separated. [Illustration ...] blocks (which can
 * span lines and nest brackets) are dropped.
 */
export function parseBook(raw: string, spec: BookSpec): ParsedBook {
  const { lines, firstLine } = stripGutenberg(raw);

  let startIdx = -1;
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (spec.start.re.test(lines[i])) {
      seen++;
      if (seen === (spec.start.occurrence ?? 1)) {
        startIdx = i;
        break;
      }
    }
  }
  if (startIdx < 0) throw new Error(`${spec.slug}: start line not found`);

  let endIdx = lines.length;
  if (spec.end) {
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (spec.end.test(lines[i].trim())) {
        endIdx = i;
        break;
      }
    }
  }

  const chapters: Chapter[] = [];
  let part: string | undefined;
  let current: Chapter | undefined;
  let buf: string[] = [];
  let bufLine = 0;
  let illustrationDepth = 0;
  let awaitingTitle = false;

  const flush = () => {
    if (buf.length && current) {
      const text = cleanText(buf.join(" "));
      if (text) current.paragraphs.push({ text, line: bufLine });
    }
    buf = [];
  };

  for (let i = startIdx; i < endIdx; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const lineNo = firstLine + i;

    if (spec.heading.test(trimmed)) {
      flush();
      illustrationDepth = 0;
      const prefix = part ? `${part} · ` : "";
      current = { index: chapters.length, title: prefix + headingLabel(trimmed), paragraphs: [] };
      chapters.push(current);
      awaitingTitle = !!spec.titleNext;
      continue;
    }
    if (spec.part && spec.part.test(trimmed)) {
      flush();
      part = partLabel(trimmed);
      continue;
    }
    if (illustrationDepth > 0 || trimmed.startsWith("[Illustration")) {
      for (const ch of line) {
        if (ch === "[") illustrationDepth++;
        else if (ch === "]") illustrationDepth = Math.max(0, illustrationDepth - 1);
      }
      flush();
      continue;
    }
    if (trimmed === "") {
      flush();
      continue;
    }
    if (awaitingTitle && current) {
      current.title += `: ${titleCase(cleanText(trimmed))}`;
      awaitingTitle = false;
      continue;
    }
    if (!current) continue; // epigraphs etc. before the first chapter heading
    if (!buf.length) bufLine = lineNo;
    buf.push(trimmed);
  }
  flush();

  return { chapters: chapters.filter((c) => c.paragraphs.length > 0).map((c, i) => ({ ...c, index: i })) };
}
