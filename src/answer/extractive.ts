// No-key answers. Picks the sentences from the retrieved passages that best
// match the question (IDF-weighted term overlap, a bonus for matching phrases,
// a small prior for higher-ranked passages) and returns them as quotes. Every
// quote is cut straight from the passage, so it passes the validator by
// construction, and it still goes through the validator like any other answer.
import { sentenceSpans } from "../corpus/chunk.js";
import type { Bm25Index } from "../search/bm25.js";
import type { Retrieved } from "../search/retrieve.js";
import { tokenize } from "../search/tokenize.js";
import type { Claim } from "./validate.js";

export interface Sentence {
  passageId: string;
  start: number;
  end: number;
  text: string;
  score: number;
}

const MIN_WORDS = 6;
const MAX_WORDS = 90;

export function sentencesOf(text: string): [number, number][] {
  const out: [number, number][] = [];
  let offset = 0;
  for (const para of text.split("\n\n")) {
    for (const [s, e] of sentenceSpans(para)) out.push([offset + s, offset + e]);
    offset += para.length + 2;
  }
  return out;
}

export function scoreSentences(question: string, passages: Retrieved[], index: Bm25Index, depth = 5): Sentence[] {
  const qTerms = [...new Set(tokenize(question))];
  if (!qTerms.length) return [];
  const qTokens = tokenize(question);
  const pairs = new Set<string>();
  for (let i = 0; i + 1 < qTokens.length; i++) pairs.add(`${qTokens[i]} ${qTokens[i + 1]}`);
  // Terms found in every retrieved passage (usually the main character's
  // name) say little about which sentence answers the question, so a term's
  // corpus IDF is scaled down by how many of the top passages contain it.
  const top = passages.slice(0, depth).map((p) => new Set(tokenize(p.chunk.text)));
  const idf = new Map(
    qTerms.map((t) => {
      const local = top.filter((s) => s.has(t)).length;
      return [t, index.idf(t) * (1 - local / (top.length + 1))];
    }),
  );
  const idfTotal = [...idf.values()].reduce((a, b) => a + b, 0);

  const out: Sentence[] = [];
  passages.slice(0, depth).forEach((p, rank) => {
    const text = p.chunk.text;
    for (const [s, e] of sentencesOf(text)) {
      const sentence = text.slice(s, e);
      const words = sentence.split(/\s+/).length;
      if (words < MIN_WORDS || words > MAX_WORDS) continue;
      const toks = tokenize(sentence);
      const set = new Set(toks);
      let score = 0;
      for (const t of qTerms) if (set.has(t)) score += idf.get(t)!;
      if (score === 0) continue;
      score *= 0.5 + score / idfTotal; // favor sentences that cover more of the question
      for (let i = 0; i + 1 < toks.length; i++) if (pairs.has(`${toks[i]} ${toks[i + 1]}`)) score += 1.5;
      score /= 1 + 0.01 * words; // mild length penalty so long sentences do not win by default
      score *= 1 - 0.06 * rank;
      out.push({ passageId: p.chunk.id, start: s, end: e, text: sentence, score });
    }
  });
  return out.sort((a, b) => b.score - a.score);
}

/** Up to `n` best distinct sentences, at most two from any one passage. */
export function extractiveClaims(question: string, passages: Retrieved[], index: Bm25Index, n = 3): { claims: Claim[]; sentences: Sentence[] } {
  const ranked = scoreSentences(question, passages, index);
  const picked: Sentence[] = [];
  const perPassage = new Map<string, number>();
  const seen = new Set<string>();
  for (const s of ranked) {
    if (picked.length >= n) break;
    // Chunks overlap, so the same sentence can come from two passages.
    const key = s.text.replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    const used = perPassage.get(s.passageId) ?? 0;
    if (used >= 2) continue;
    perPassage.set(s.passageId, used + 1);
    picked.push(s);
  }
  return {
    sentences: picked,
    claims: picked.map((s) => ({ text: s.text, citations: [{ passageId: s.passageId, quote: s.text }] })),
  };
}
