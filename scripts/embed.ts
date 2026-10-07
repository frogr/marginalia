// Optional: build dense vectors for hybrid retrieval.
//
//   OPENAI_API_KEY=sk-... npm run embed
//
// Embeds every chunk with text-embedding-3-small (512 dimensions) and writes
// data/embeddings/vectors.bin (Float32, normalized) and meta.json. About 7,100
// chunks and about 1.6 million words per run. Without a key this
// script does nothing and exits 0, so it is safe in a build command.
// The output (7,107 x 512 floats, about 15 MB) is git-ignored and built at deploy time.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { UpstreamError } from "../src/http.js";
import { DATA_DIR, Library } from "../src/library.js";
import { EMBED_DIMS, embed } from "../src/search/vectors.js";

const BATCH = 96;

async function main() {
  const cfg = loadConfig();
  if (!cfg.openaiKey) {
    console.log("OPENAI_API_KEY is not set; skipping embeddings (BM25-only retrieval).");
    return;
  }
  const lib = new Library(Library.readBooks());
  const out = new Float32Array(lib.chunks.length * EMBED_DIMS);
  for (let i = 0; i < lib.chunks.length; i += BATCH) {
    const batch = lib.chunks.slice(i, i + BATCH);
    let vectors: Float32Array[] | undefined;
    for (let attempt = 0; !vectors; attempt++) {
      try {
        // Prefix each chunk with its book and chapter so the vector knows where it comes from.
        vectors = await embed(
          batch.map((c) => `${lib.books.get(c.book)!.title}, ${c.chapterTitle}\n\n${c.text}`),
          { apiKey: cfg.openaiKey, model: cfg.embeddingModel, timeoutMs: 60_000 },
        );
      } catch (e) {
        const retryable = e instanceof UpstreamError && (e.kind === "rate_limit" || e.kind === "upstream" || e.kind === "timeout");
        if (!retryable || attempt >= 5) throw e;
        const wait = 2000 * 2 ** attempt;
        console.warn(`${(e as Error).message}; retrying in ${wait / 1000}s`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    vectors.forEach((v, j) => out.set(v, (i + j) * EMBED_DIMS));
    process.stdout.write(`\rembedded ${Math.min(i + BATCH, lib.chunks.length)}/${lib.chunks.length}`);
  }
  const dir = join(DATA_DIR, "embeddings");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "vectors.bin"), Buffer.from(out.buffer));
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ model: cfg.embeddingModel, dims: EMBED_DIMS, ids: lib.chunks.map((c) => c.id) }));
  console.log(`\nwrote ${dir}`);
}

main().catch((e) => {
  console.error(`embedding failed: ${(e as Error).message}`);
  process.exit(1);
});
