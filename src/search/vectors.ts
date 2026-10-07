// Optional dense retrieval. `npm run embed` (with OPENAI_API_KEY set) writes
// one normalized Float32 vector per chunk to data/embeddings/. At query time the
// question is embedded with the same model and compared by dot product.
// Without the files or the key, Marginalia runs on BM25 alone.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchJson } from "../http.js";

export const EMBED_DIMS = 512;

export interface EmbeddingMeta {
  model: string;
  dims: number;
  ids: string[];
}

export class VectorIndex {
  constructor(
    readonly meta: EmbeddingMeta,
    private readonly vectors: Float32Array,
  ) {}

  static load(dir: string, chunkIds: string[]): VectorIndex | undefined {
    const metaPath = join(dir, "meta.json");
    const binPath = join(dir, "vectors.bin");
    if (!existsSync(metaPath) || !existsSync(binPath)) return undefined;
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as EmbeddingMeta;
    const buf = readFileSync(binPath);
    const vectors = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    // Stale embeddings (built from different chunks) are worse than none.
    if (meta.ids.length !== chunkIds.length || meta.ids.some((id, i) => id !== chunkIds[i])) {
      console.warn("embeddings do not match the current chunks; run `npm run embed`. Using BM25 only.");
      return undefined;
    }
    if (vectors.length !== meta.ids.length * meta.dims) return undefined;
    return new VectorIndex(meta, vectors);
  }

  /** Indices of the k nearest chunks to `q` (already normalized), optionally limited by a predicate. */
  search(q: Float32Array, k: number, allow?: (i: number) => boolean): { index: number; score: number }[] {
    const { dims } = this.meta;
    const n = this.meta.ids.length;
    const top: { index: number; score: number }[] = [];
    for (let i = 0; i < n; i++) {
      if (allow && !allow(i)) continue;
      let s = 0;
      const off = i * dims;
      for (let d = 0; d < dims; d++) s += q[d] * this.vectors[off + d];
      if (top.length < k || s > top[top.length - 1].score) {
        top.push({ index: i, score: s });
        top.sort((a, b) => b.score - a.score);
        if (top.length > k) top.pop();
      }
    }
    return top;
  }
}

export function normalize(v: number[]): Float32Array {
  const out = Float32Array.from(v);
  let n = 0;
  for (const x of out) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= n;
  return out;
}

export async function embed(texts: string[], opts: { apiKey: string; model: string; timeoutMs: number }): Promise<Float32Array[]> {
  const json = await fetchJson<{ data: { index: number; embedding: number[] }[] }>("https://api.openai.com/v1/embeddings", {
    headers: { authorization: `Bearer ${opts.apiKey}` },
    body: { model: opts.model, input: texts, dimensions: EMBED_DIMS },
    timeoutMs: opts.timeoutMs,
    provider: "OpenAI",
  });
  return json.data.sort((a, b) => a.index - b.index).map((d) => normalize(d.embedding));
}
