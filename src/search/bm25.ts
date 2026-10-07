// Okapi BM25 over chunk texts, with two additions that matter for questions
// about novels:
//
// 1. Phrase boost. Pairs of query terms that are adjacent in the query (after
//    stopwords are dropped) get a bonus when they are also adjacent in a
//    candidate chunk, so "white whale" prefers chunks that say "white whale"
//    over chunks that say "white" and "whale" far apart. Text in double quotes
//    in the query gets a larger bonus when it appears verbatim.
// 2. Book filter. Restricts scoring to chunks from the given books.
//
// Phrase checks only run on the top `rerankDepth` BM25 candidates, so they cost
// a few hundred re-tokenizations per query, not a pass over the corpus.
import { fold, tokenize } from "./tokenize.js";

export interface Bm25Doc {
  text: string;
  book: string;
  /** Docs with the same group (a chapter) that are adjacent in the array are neighbors. */
  group?: string;
}

export interface Bm25Options {
  k?: number;
  books?: Iterable<string>;
  /** Bonus per adjacent query term pair found adjacent in the chunk. 0 disables. */
  phraseBoost?: number;
  /** Bonus when a "quoted phrase" from the query appears verbatim. */
  quoteBoost?: number;
  /** Multiply scores of chunks from these books (used for books named in the question). */
  bookWeights?: Map<string, number>;
  rerankDepth?: number;
  /**
   * Add this fraction of the best neighbor's score to each chunk. A passage
   * often names the people and place one paragraph before the event itself,
   * so the chunk with the event shares in its neighbor's match. 0 disables.
   */
  neighborWeight?: number;
}

export interface Bm25Hit {
  index: number;
  score: number;
  /** Plain BM25 part of the score, before boosts. */
  bm25: number;
}

interface Posting {
  docs: Int32Array;
  tfs: Uint16Array;
}

export class Bm25Index {
  readonly k1: number;
  readonly b: number;
  private readonly docs: Bm25Doc[];
  private readonly lengths: Uint32Array;
  private readonly avgdl: number;
  private readonly postings = new Map<string, Posting>();

  constructor(docs: Bm25Doc[], params: { k1?: number; b?: number } = {}) {
    this.k1 = params.k1 ?? 1.2;
    this.b = params.b ?? 0.75;
    this.docs = docs;
    this.lengths = new Uint32Array(docs.length);
    const tmp = new Map<string, { docs: number[]; tfs: number[] }>();
    let total = 0;
    docs.forEach((d, i) => {
      const toks = tokenize(d.text);
      this.lengths[i] = toks.length;
      total += toks.length;
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const [t, n] of tf) {
        let p = tmp.get(t);
        if (!p) tmp.set(t, (p = { docs: [], tfs: [] }));
        p.docs.push(i);
        p.tfs.push(Math.min(n, 65535));
      }
    });
    this.avgdl = docs.length ? total / docs.length : 0;
    for (const [t, p] of tmp) this.postings.set(t, { docs: Int32Array.from(p.docs), tfs: Uint16Array.from(p.tfs) });
  }

  get size() {
    return this.docs.length;
  }

  idf(term: string): number {
    const df = this.postings.get(term)?.docs.length ?? 0;
    return Math.log(1 + (this.docs.length - df + 0.5) / (df + 0.5));
  }

  search(query: string, opts: Bm25Options = {}): Bm25Hit[] {
    const k = opts.k ?? 10;
    const phraseBoost = opts.phraseBoost ?? 1.5;
    const quoteBoost = opts.quoteBoost ?? 6;
    const rerankDepth = opts.rerankDepth ?? 200;
    const allow = opts.books ? new Set(opts.books) : undefined;
    if (allow && allow.size === 0) return [];

    const terms = tokenize(query);
    const unique = [...new Set(terms)];
    const scores = new Map<number, number>();
    for (const t of unique) {
      const p = this.postings.get(t);
      if (!p) continue;
      const idf = this.idf(t);
      for (let j = 0; j < p.docs.length; j++) {
        const d = p.docs[j];
        if (allow && !allow.has(this.docs[d].book)) continue;
        const tf = p.tfs[j];
        const norm = tf + this.k1 * (1 - this.b + (this.b * this.lengths[d]) / this.avgdl);
        scores.set(d, (scores.get(d) ?? 0) + (idf * (tf * (this.k1 + 1))) / norm);
      }
    }

    const neighborWeight = opts.neighborWeight ?? 0;
    let base = scores;
    if (neighborWeight > 0) {
      base = new Map<number, number>();
      const near = (a: number, b: number) => b >= 0 && b < this.docs.length && this.docs[a].group !== undefined && this.docs[a].group === this.docs[b].group;
      for (const d of scores.keys()) {
        for (const c of [d - 1, d, d + 1]) {
          if (base.has(c) || (c !== d && !near(d, c))) continue;
          const nb = Math.max(near(c, c - 1) ? (scores.get(c - 1) ?? 0) : 0, near(c, c + 1) ? (scores.get(c + 1) ?? 0) : 0);
          base.set(c, (scores.get(c) ?? 0) + neighborWeight * nb);
        }
      }
    }

    let hits: Bm25Hit[] = [...base].map(([index, s]) => ({ index, score: s, bm25: scores.get(index) ?? 0 }));
    if (opts.bookWeights?.size) {
      for (const h of hits) h.score *= opts.bookWeights.get(this.docs[h.index].book) ?? 1;
    }
    hits.sort((a, b) => b.score - a.score);

    const pairs = new Set<string>();
    for (let i = 0; i + 1 < terms.length; i++) if (terms[i] !== terms[i + 1]) pairs.add(`${terms[i]} ${terms[i + 1]}`);
    const quoted = [...query.matchAll(/["“]([^"”]{3,})["”]/g)].map((m) => fold(m[1]).replace(/\s+/g, " ").trim());

    if ((phraseBoost > 0 && pairs.size) || (quoteBoost > 0 && quoted.length)) {
      const head = hits.slice(0, rerankDepth);
      for (const h of head) {
        const text = this.docs[h.index].text;
        if (phraseBoost > 0 && pairs.size) {
          const toks = tokenize(text);
          const seen = new Set<string>();
          for (let i = 0; i + 1 < toks.length; i++) {
            const pair = `${toks[i]} ${toks[i + 1]}`;
            if (pairs.has(pair)) seen.add(pair);
          }
          h.score += phraseBoost * seen.size;
        }
        if (quoteBoost > 0 && quoted.length) {
          const folded = fold(text).replace(/\s+/g, " ");
          for (const q of quoted) if (folded.includes(q)) h.score += quoteBoost;
        }
      }
      head.sort((a, b) => b.score - a.score);
      hits = head.concat(hits.slice(rerankDepth));
    }
    return hits.slice(0, k);
  }
}
