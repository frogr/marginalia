import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMBED_DIMS, VectorIndex, embed, normalize } from "../src/search/vectors.js";

afterEach(() => vi.unstubAllGlobals());

function write(ids: string[], vectors: number[][]) {
  const dir = mkdtempSync(join(tmpdir(), "marginalia-"));
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ model: "m", dims: 2, ids }));
  writeFileSync(join(dir, "vectors.bin"), Buffer.from(Float32Array.from(vectors.flat()).buffer));
  return dir;
}

describe("VectorIndex", () => {
  it("loads vectors and returns nearest chunks, honoring a filter", () => {
    const dir = write(["a", "b", "c"], [[1, 0], [0, 1], [0.7, 0.7]]);
    const v = VectorIndex.load(dir, ["a", "b", "c"])!;
    expect(v.search(normalize([1, 0.1]), 2).map((h) => h.index)).toEqual([0, 2]);
    expect(v.search(normalize([1, 0.1]), 1, (i) => i !== 0).map((h) => h.index)).toEqual([2]);
  });

  it("refuses embeddings built for different chunks", () => {
    const dir = write(["a", "b"], [[1, 0], [0, 1]]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(VectorIndex.load(dir, ["a", "x"])).toBeUndefined();
    expect(VectorIndex.load(join(dir, "missing"), ["a", "b"])).toBeUndefined();
  });
});

describe("embed", () => {
  it("calls the OpenAI embeddings API and normalizes in input order", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ index: 1, embedding: [0, 2] }, { index: 0, embedding: [3, 4] }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const out = await embed(["x", "y"], { apiKey: "k", model: "text-embedding-3-small", timeoutMs: 1000 });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toEqual({ model: "text-embedding-3-small", input: ["x", "y"], dimensions: EMBED_DIMS });
    expect([...out[0]]).toEqual([expect.closeTo(0.6), expect.closeTo(0.8)]);
    expect([...out[1]]).toEqual([0, 1]);
  });
});
