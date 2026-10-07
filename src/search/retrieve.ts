// Retrieval: BM25 always, plus dense vectors fused with RRF when embeddings
// exist and an embedding function is supplied (OPENAI_API_KEY at runtime).
import type { Chunk } from "../corpus/chunk.js";
import type { Library } from "../library.js";
import type { Bm25Options } from "./bm25.js";
import { rrf } from "./fusion.js";

export interface RetrieveOptions {
  k?: number;
  /** Only search these books. Empty or missing means all books. */
  books?: string[];
  bm25?: Bm25Options;
  /**
   * Score multiplier for books named in the question ("in Dracula, ...").
   * 1 turns it off. Only applies when no explicit book filter is set.
   */
  namedBookBoost?: number;
  /** Embeds the question. When missing or when the library has no vectors, BM25 only. */
  embedQuery?: (q: string) => Promise<Float32Array>;
}

export interface Retrieved {
  chunk: Chunk;
  rank: number;
  /** Final ranking score (BM25 with boosts, or RRF when hybrid). */
  score: number;
  bm25Score: number | null;
  bm25Rank: number | null;
  vectorScore: number | null;
  vectorRank: number | null;
}

export interface Retrieval {
  method: "bm25" | "hybrid";
  passages: Retrieved[];
  namedBooks: string[];
  /** Set when hybrid was possible but the embedding call failed. */
  note?: string;
}

export const DEFAULT_NAMED_BOOK_BOOST = 1.6;
export const DEFAULT_NEIGHBOR_WEIGHT = 0.3;
const FUSION_DEPTH = 50;

export async function retrieve(lib: Library, question: string, opts: RetrieveOptions = {}): Promise<Retrieval> {
  const k = opts.k ?? 8;
  const filter = opts.books?.filter((b) => lib.books.has(b));
  const books = filter?.length ? filter : undefined;
  const namedBooks = lib.booksNamedIn(question);
  const boost = opts.namedBookBoost ?? DEFAULT_NAMED_BOOK_BOOST;
  const bookWeights = !books && boost !== 1 && namedBooks.length ? new Map(namedBooks.map((b) => [b, boost])) : undefined;

  const hits = lib.bm25.search(question, { neighborWeight: DEFAULT_NEIGHBOR_WEIGHT, ...opts.bm25, k: Math.max(k, FUSION_DEPTH), books, bookWeights });
  const bm25 = hits.map((h, i) => ({ id: lib.chunks[h.index].id, score: h.score, rank: i + 1 }));
  const bm25ById = new Map(bm25.map((b) => [b.id, b]));

  if (lib.vectors && opts.embedQuery) {
    try {
      const q = await opts.embedQuery(question);
      const allowSet = books ? new Set(books) : undefined;
      const vec = lib.vectors
        .search(q, FUSION_DEPTH, allowSet ? (i) => allowSet.has(lib.chunks[i].book) : undefined)
        .map((v, i) => ({ id: lib.chunks[v.index].id, score: v.score, rank: i + 1 }));
      const vecById = new Map(vec.map((v) => [v.id, v]));
      const fused = rrf([bm25, vec]).slice(0, k);
      return {
        method: "hybrid",
        namedBooks,
        passages: fused.map((f, i) => ({
          chunk: lib.chunkById.get(f.id)!,
          rank: i + 1,
          score: f.score,
          bm25Score: bm25ById.get(f.id)?.score ?? null,
          bm25Rank: f.ranks[0],
          vectorScore: vecById.get(f.id)?.score ?? null,
          vectorRank: f.ranks[1],
        })),
      };
    } catch (e) {
      console.warn(`query embedding failed, using BM25 only: ${(e as Error).message}`);
      return { ...bm25Only(), note: "Vector search was unavailable for this question, so only keyword search was used." };
    }
  }
  return bm25Only();

  function bm25Only(): Retrieval {
    return {
      method: "bm25",
      namedBooks,
      passages: bm25.slice(0, k).map((b) => ({
        chunk: lib.chunkById.get(b.id)!,
        rank: b.rank,
        score: b.score,
        bm25Score: b.score,
        bm25Rank: b.rank,
        vectorScore: null,
        vectorRank: null,
      })),
    };
  }
}
