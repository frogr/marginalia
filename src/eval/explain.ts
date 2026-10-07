// npm run eval:explain -- d09 x01 [--baseline]
//
// For each question id: the query terms with their IDF, the top 3 chunks and
// which terms they matched, and where each gold chunk ranks. --baseline uses
// the first config in the ablation (plain BM25, 160-word chunks).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalize } from "../answer/validate.js";
import { DEFAULT_CHUNK_OPTIONS, SMALL_CHUNK_OPTIONS } from "../corpus/chunk.js";
import { Library, ROOT } from "../library.js";
import { DEFAULT_NEIGHBOR_WEIGHT, retrieve } from "../search/retrieve.js";
import { tokenize } from "../search/tokenize.js";

const args = process.argv.slice(2);
const baseline = args.includes("--baseline");
const ids = args.filter((a) => !a.startsWith("--"));
const qs = ["questions.json", "holdout.json"].flatMap(
  (f) => (JSON.parse(readFileSync(join(ROOT, "evals", f), "utf8")) as { questions: { id: string; book: string; question: string; gold: string[] }[] }).questions,
);
const lib = new Library(Library.readBooks(), baseline ? SMALL_CHUNK_OPTIONS : DEFAULT_CHUNK_OPTIONS);
const bm25 = baseline ? { phraseBoost: 0, quoteBoost: 0, neighborWeight: 0 } : { neighborWeight: DEFAULT_NEIGHBOR_WEIGHT };
console.log(baseline ? "config: plain BM25, 160-word chunks" : "config: shipped");

for (const q of qs.filter((x) => ids.includes(x.id))) {
  const terms = tokenize(q.question);
  const r = await retrieve(lib, q.question, { k: 3, bm25, namedBookBoost: baseline ? 1 : undefined });
  console.log(`\n${q.id}: ${q.question}\n  terms: ${terms.map((t) => `${t}(${lib.bm25.idf(t).toFixed(1)})`).join(" ")}`);
  for (const p of r.passages) {
    const has = new Set(tokenize(p.chunk.text));
    console.log(`  top ${p.rank}: ${p.chunk.id} score=${p.score.toFixed(2)} matched=[${terms.filter((t) => has.has(t)).join(" ")}]`);
  }
  const all = lib.bm25.search(q.question, { ...bm25, k: lib.chunks.length });
  for (const g of lib.chunks.filter((c) => c.book === q.book && q.gold.some((s) => normalize(c.text).includes(normalize(s))))) {
    const has = new Set(tokenize(g.text));
    const rank = all.findIndex((h) => lib.chunks[h.index].id === g.id) + 1;
    console.log(`  gold: ${g.id} rank=${rank || "unscored"} matched=[${terms.filter((t) => has.has(t)).join(" ")}]`);
  }
}
