import { describe, expect, it } from "vitest";
import { Library } from "../src/library.js";
import { Bm25Index } from "../src/search/bm25.js";
import { rrf } from "../src/search/fusion.js";
import { retrieve } from "../src/search/retrieve.js";
import { tokenize } from "../src/search/tokenize.js";
import { TINY } from "./fixtures.js";

describe("tokenize", () => {
  it("lowercases, drops stopwords and possessives, and stems", () => {
    expect(tokenize("The Whale's whales were hunting")).toEqual(["whale", "whale", "hunt"]);
    expect(tokenize("Café NAÏVE")).toEqual(["cafe", "naiv"]);
  });
});

describe("Bm25Index", () => {
  const docs = [
    { text: "the white whale swam past the ship", book: "a" },
    { text: "a white house and a grey whale far away from each other in the long story", book: "a" },
    { text: "the captain of the ship", book: "b" },
    { text: "whales and more whales and whaling", book: "b" },
  ];
  const idx = new Bm25Index(docs);

  it("ranks documents with rarer matching terms higher", () => {
    const hits = idx.search("captain", { k: 5 });
    expect(hits.map((h) => h.index)).toEqual([2]);
  });

  it("matches stems, so 'whaling' finds 'whale'", () => {
    const hits = idx.search("whaling", { k: 5 });
    expect(hits.map((h) => h.index)).toContain(0);
  });

  it("returns nothing for stopword-only queries", () => {
    expect(idx.search("the and of", { k: 5 })).toEqual([]);
  });

  it("filters by book", () => {
    const hits = idx.search("white whale ship", { k: 5, books: ["b"] });
    expect(hits.every((h) => docs[h.index].book === "b")).toBe(true);
    expect(idx.search("whale", { books: [] })).toEqual([]);
  });

  it("boosts chunks where query terms are adjacent", () => {
    const plain = idx.search("white whale", { k: 2, phraseBoost: 0 });
    const boosted = idx.search("white whale", { k: 2, phraseBoost: 3 });
    expect(boosted[0].index).toBe(0);
    expect(boosted[0].score - boosted[0].bm25).toBeCloseTo(3);
    expect(plain[0].score).toBe(plain[0].bm25);
  });

  it("boosts an exact quoted phrase", () => {
    const hits = idx.search('"grey whale far away"', { k: 1, phraseBoost: 0 });
    expect(hits[0].index).toBe(1);
    expect(hits[0].score).toBeGreaterThan(hits[0].bm25 + 5);
  });

  it("lets a chunk share in its neighbor's score within a group", () => {
    const grouped = new Bm25Index([
      { text: "Elizabeth went to the wedding", book: "a", group: "a:1" },
      { text: "She lay lifeless across the bed", book: "a", group: "a:1" },
      { text: "Something else entirely", book: "a", group: "a:2" },
    ]);
    expect(grouped.search("Elizabeth wedding", { k: 5 }).map((h) => h.index)).toEqual([0]);
    const smoothed = grouped.search("Elizabeth wedding", { k: 5, neighborWeight: 0.5 });
    expect(smoothed.map((h) => h.index)).toEqual([0, 1]);
    expect(smoothed[1].score).toBeCloseTo(smoothed[0].score * 0.5);
    expect(smoothed[1].bm25).toBe(0);
  });
});

describe("rrf", () => {
  it("fuses ranked lists by 1/(k + rank)", () => {
    const fused = rrf([[{ id: "a" }, { id: "b" }, { id: "c" }], [{ id: "c" }, { id: "a" }]], 60);
    expect(fused.map((f) => f.id)).toEqual(["a", "c", "b"]);
    expect(fused[0].score).toBeCloseTo(1 / 61 + 1 / 62);
    expect(fused[0].ranks).toEqual([1, 2]);
    expect(fused[2].ranks).toEqual([2, null]);
  });

  it("counts an id once per list and breaks ties by id", () => {
    const fused = rrf([[{ id: "b" }, { id: "b" }], [{ id: "a" }]]);
    expect(fused.map((f) => f.id)).toEqual(["a", "b"]);
    expect(fused[1].score).toBeCloseTo(1 / 61);
  });
});

describe("retrieve", () => {
  const lib = new Library(structuredClone(TINY));

  it("finds the right book without a filter", async () => {
    const r = await retrieve(lib, "Why was the captain angry at the white whale?", { k: 2 });
    expect(r.method).toBe("bm25");
    expect(r.passages[0].chunk.book).toBe("whales");
  });

  it("detects a book named in the question", async () => {
    const r = await retrieve(lib, "In The Manners Book, who walked through the mud?");
    expect(r.namedBooks).toEqual(["manners"]);
  });

  it("fuses BM25 with vectors when both are available", async () => {
    const ids = lib.chunks.map((c) => c.id);
    const dims = 2;
    const vecs = new Float32Array(ids.length * dims);
    // Point the last chunk's vector at the query, so it only ranks high through the vector list.
    vecs.set([1, 0], (ids.length - 1) * dims);
    const { VectorIndex } = await import("../src/search/vectors.js");
    lib.vectors = new VectorIndex({ model: "test", dims, ids }, vecs);
    const r = await retrieve(lib, "captain white whale", { k: 3, embedQuery: async () => Float32Array.from([1, 0]) });
    expect(r.method).toBe("hybrid");
    expect(r.passages.some((p) => p.vectorRank === 1 && p.chunk.id === ids[ids.length - 1])).toBe(true);

    const failed = await retrieve(lib, "captain", { embedQuery: async () => Promise.reject(new Error("down")) });
    expect(failed.method).toBe("bm25");
    expect(failed.note).toMatch(/keyword search/);
    lib.vectors = undefined;
  });
});
