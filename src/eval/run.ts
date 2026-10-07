// npm run eval
//
// 1. Retrieval: Recall@1/5/10 and MRR on evals/questions.json, overall and by
//    question type, for each retrieval configuration in CONFIGS (an ablation,
//    so every change can be compared against the one before it). No book
//    filter is applied: the retriever has to find the right book on its own.
// 2. Extractive answers: how often the no-key answer quotes a gold passage.
// 3. Validator: planted fake quotes that must all be caught, plus real quotes
//    that must all pass.
//
// Writes evals/results/{retrieval,validator}.json and evals/results/summary.md.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractiveClaims, sentencesOf } from "../answer/extractive.js";
import { checkQuote, normalize } from "../answer/validate.js";
import { DEFAULT_CHUNK_OPTIONS, SMALL_CHUNK_OPTIONS, type ChunkOptions } from "../corpus/chunk.js";
import { Library, ROOT } from "../library.js";
import { retrieve, type RetrieveOptions } from "../search/retrieve.js";

interface Question {
  id: string;
  type: string;
  book: string;
  question: string;
  gold: string[];
}

interface Config {
  name: string;
  description: string;
  chunks?: ChunkOptions;
  retrieve: RetrieveOptions;
}

// An ablation: each row adds one change to the row before it. The last row is what the app ships.
// Rows 1-3 use the original 160-word chunks; the error analysis in PROOF.md led to rows 4-5.
const plain = { phraseBoost: 0, quoteBoost: 0, neighborWeight: 0 };
export const CONFIGS: Config[] = [
  { name: "bm25", description: "Plain BM25 (stemming, stopwords), 160-word chunks", chunks: SMALL_CHUNK_OPTIONS, retrieve: { bm25: plain, namedBookBoost: 1 } },
  { name: "+phrase", description: "+ adjacent-term phrase boost", chunks: SMALL_CHUNK_OPTIONS, retrieve: { bm25: { neighborWeight: 0 }, namedBookBoost: 1 } },
  { name: "+title", description: "+ boost for books named in the question", chunks: SMALL_CHUNK_OPTIONS, retrieve: { bm25: { neighborWeight: 0 } } },
  { name: "+240w chunks", description: "+ 240-word chunks instead of 160", retrieve: { bm25: { neighborWeight: 0 } } },
  { name: "+neighbors (shipped)", description: "+ 0.3 x best neighbor chunk's score", retrieve: {} },
];

const TYPES = ["direct", "paraphrased", "name-free", "cross-book"];
const K = 10;

const load = (f: string) => (JSON.parse(readFileSync(join(ROOT, "evals", f), "utf8")) as { questions: Question[] }).questions;
const questions = load("questions.json");
const holdout = load("holdout.json");
const outDir = join(ROOT, "evals/results");
mkdirSync(outDir, { recursive: true });
const books = Library.readBooks();

function goldCheck(lib: Library) {
  // Every gold snippet must exist in its book, or the question is broken.
  const problems: string[] = [];
  const bookText = new Map<string, string>();
  for (const q of [...questions, ...holdout]) {
    let text = bookText.get(q.book);
    if (text === undefined) bookText.set(q.book, (text = normalize(lib.chunks.filter((c) => c.book === q.book).map((c) => c.text).join(" "))));
    for (const g of q.gold) if (!text.includes(normalize(g))) problems.push(`${q.id}: gold not found in ${q.book}: "${g}"`);
  }
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
}

const isGold = (q: Question, chunk: { book: string; text: string }) => {
  if (chunk.book !== q.book) return false;
  const t = normalize(chunk.text);
  return q.gold.some((g) => t.includes(normalize(g)));
};

interface Row {
  n: number;
  r1: number;
  r5: number;
  r10: number;
  /** Top result is from the right book, whatever the passage. */
  book1: number;
  mrr: number;
}
const pct = (x: number) => Math.round(x * 1000) / 10;

interface Scored {
  rank: number | null;
  bookAt1: boolean;
}

function summarize(qs: Scored[]): Row {
  const ranks = qs.map((q) => q.rank);
  const n = ranks.length;
  const at = (k: number) => ranks.filter((r) => r !== null && r <= k).length / n;
  return {
    n,
    r1: pct(at(1)),
    r5: pct(at(5)),
    r10: pct(at(10)),
    book1: pct(qs.filter((q) => q.bookAt1).length / n),
    mrr: Math.round((ranks.reduce<number>((s, r) => s + (r ? 1 / r : 0), 0) / n) * 1000) / 1000,
  };
}

const libCache = new Map<string, Library>();
function libFor(opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS) {
  const key = JSON.stringify(opts);
  let lib = libCache.get(key);
  if (!lib) libCache.set(key, (lib = new Library(structuredClone(books), opts)));
  return lib;
}

const retrievalResults = [];
const checked = new Set<Library>();
const shipped = CONFIGS[CONFIGS.length - 1];
let shippedPerQuestion: { id: string; type: string; rank: number | null; top: string[] }[] = [];

for (const cfg of CONFIGS) {
  const lib = libFor(cfg.chunks);
  if (!checked.has(lib)) goldCheck(lib), checked.add(lib);
  const run = async (set: Question[]) => {
    const out = [];
    for (const q of set) {
      const r = await retrieve(lib, q.question, { ...cfg.retrieve, k: K });
      const idx = r.passages.findIndex((p) => isGold(q, p.chunk));
      out.push({ id: q.id, type: q.type, rank: idx >= 0 ? idx + 1 : null, bookAt1: r.passages[0]?.chunk.book === q.book, top: r.passages.slice(0, 3).map((p) => p.chunk.id) });
    }
    return out;
  };
  const perQuestion = await run(questions);
  const holdoutPerQuestion = await run(holdout);
  const byType = Object.fromEntries(TYPES.map((t) => [t, summarize(perQuestion.filter((p) => p.type === t))]));
  retrievalResults.push({
    config: cfg.name,
    description: cfg.description,
    chunks: lib.chunks.length,
    overall: summarize(perQuestion),
    byType,
    holdout: summarize(holdoutPerQuestion),
    perQuestion,
    holdoutPerQuestion,
  });
  if (cfg === shipped) shippedPerQuestion = perQuestion;
}

// Extractive answers with the shipped config: does the no-key answer quote a gold chunk?
const lib = libFor(shipped.chunks);
let extractiveHits = 0;
for (const q of questions) {
  const r = await retrieve(lib, q.question, { ...shipped.retrieve, k: 8 });
  const { sentences } = extractiveClaims(q.question, r.passages, lib.bm25);
  const cited = new Set(sentences.map((s) => s.passageId));
  if (r.passages.some((p) => cited.has(p.chunk.id) && isGold(q, p.chunk))) extractiveHits++;
}

// ---------- Validator: planted fakes ----------
const FABRICATED = [
  "The rain fell softly on the garden as she read the letter twice.",
  "He swore he would never again set foot upon that cursed shore.",
  "I have always believed that kindness is the truest form of courage.",
  "The old house groaned beneath the weight of its forgotten secrets.",
  "Nothing in the world is so dear to me as an honest friend.",
  "She laughed, and the sound of it was like silver bells in winter.",
];

function pickSentence(text: string, minWords = 8, maxWords = 40): string | undefined {
  const all = sentencesOf(text).map(([s, e]) => text.slice(s, e));
  return all.filter((s) => {
    const w = s.split(/\s+/).length;
    return w >= minWords && w <= maxWords;
  })[0];
}

function swapWord(s: string): string {
  // Replace the longest plain word (letters only) with "silver", or "golden" if it already is "silver".
  const words = s.split(" ");
  let best = -1;
  words.forEach((w, i) => {
    if (/^[A-Za-z]+$/.test(w) && (best < 0 || w.length > words[best].length)) best = i;
  });
  if (best < 0) return `silver ${s}`;
  words[best] = words[best].toLowerCase() === "silver" ? "golden" : "silver";
  return words.join(" ");
}

const restyle = (s: string) => s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/ /g, "  ").replace(/—/g, " -- ");

type Case = { category: string; shouldPass: boolean; quote: string; cite: string; retrieved: Map<string, string>; verified?: boolean; reason?: string };
const cases: Case[] = [];
let f = 0;
for (const q of questions) {
  const r = await retrieve(lib, q.question, { ...shipped.retrieve, k: 8 });
  const retrieved = new Map(r.passages.map((p) => [p.chunk.id, p.chunk.text]));
  const [p1, ...rest] = r.passages.map((p) => p.chunk);
  const s = pickSentence(p1.text);
  if (!s) continue;
  const other = rest.find((c) => !normalize(c.text).includes(normalize(s)));
  const words = s.split(" ");
  const head = words.slice(0, 4).join(" ");
  const tail = words.slice(-4).join(" ");
  // A chunk from a different book, never retrieved for this question.
  const outsider = lib.chunks.find((c, i) => i % 97 === questions.indexOf(q) % 97 && c.book !== p1.book && !retrieved.has(c.id))!;
  const outsiderSentence = pickSentence(outsider.text) ?? outsider.text.slice(0, 120);

  cases.push({ category: "real: exact sentence", shouldPass: true, quote: s, cite: p1.id, retrieved });
  cases.push({ category: "real: quote marks, dashes and spacing restyled", shouldPass: true, quote: restyle(s), cite: p1.id, retrieved });
  if (words.length >= 10) cases.push({ category: "real: ellipsis between two exact pieces", shouldPass: true, quote: `${head} ... ${tail}`, cite: p1.id, retrieved });

  cases.push({ category: "fake: invented sentence", shouldPass: false, quote: FABRICATED[f++ % FABRICATED.length], cite: p1.id, retrieved });
  cases.push({ category: "fake: one word changed", shouldPass: false, quote: swapWord(s), cite: p1.id, retrieved });
  if (other) cases.push({ category: "fake: real quote, wrong passage cited", shouldPass: false, quote: s, cite: other.id, retrieved });
  cases.push({ category: "fake: real piece ... invented piece", shouldPass: false, quote: `${head} ... ${FABRICATED[f++ % FABRICATED.length]}`, cite: p1.id, retrieved });
  if (words.length >= 10) cases.push({ category: "fake: real pieces in the wrong order", shouldPass: false, quote: `${tail} ... ${head}`, cite: p1.id, retrieved });
  cases.push({ category: "fake: real text from a passage that was not retrieved", shouldPass: false, quote: outsiderSentence, cite: outsider.id, retrieved });
  cases.push({ category: "fake: too short to mean anything", shouldPass: false, quote: words.slice(0, 2).join(" "), cite: p1.id, retrieved });
}
for (const c of cases) {
  const r = checkQuote(c.quote, c.cite, c.retrieved);
  c.verified = r.verified;
  c.reason = r.reason;
}
const categories = [...new Set(cases.map((c) => c.category))].map((category) => {
  const cs = cases.filter((c) => c.category === category);
  const correct = cs.filter((c) => c.verified === c.shouldPass).length;
  return { category, shouldPass: cs[0].shouldPass, total: cs.length, correct };
});
const fakes = cases.filter((c) => !c.shouldPass);
const reals = cases.filter((c) => c.shouldPass);
const validator = {
  fakesCaught: fakes.filter((c) => !c.verified).length,
  fakesTotal: fakes.length,
  realPassed: reals.filter((c) => c.verified).length,
  realTotal: reals.length,
  categories,
  failures: cases.filter((c) => c.verified !== c.shouldPass).map(({ retrieved: _r, ...c }) => c),
};

// ---------- Output ----------
writeFileSync(join(outDir, "retrieval.json"), JSON.stringify({ k: K, questions: questions.length, holdout: holdout.length, results: retrievalResults }, null, 2) + "\n");
writeFileSync(join(outDir, "validator.json"), JSON.stringify(validator, null, 2) + "\n");

const lines: string[] = [];
lines.push(`# Eval results`, "", `Generated by \`npm run eval\`. Top ${K} passages retrieved per question, no book filter. A hit is a retrieved chunk from the right book that contains a hand-checked gold snippet. Book@1 counts questions whose top result is from the right book, even if it is the wrong passage.`, "");
lines.push(`## Retrieval (${questions.length} development questions)`, "", "| config | chunks | R@1 | R@5 | R@10 | MRR | Book@1 |", "|---|---|---|---|---|---|---|");
for (const r of retrievalResults) lines.push(`| ${r.config} | ${r.chunks} | ${r.overall.r1}% | ${r.overall.r5}% | ${r.overall.r10}% | ${r.overall.mrr} | ${r.overall.book1}% |`);
lines.push("", `## Held-out questions (${holdout.length}, written after the shipped config was chosen)`, "", "| config | R@1 | R@5 | R@10 | MRR | Book@1 |", "|---|---|---|---|---|---|");
for (const r of retrievalResults) lines.push(`| ${r.config} | ${r.holdout.r1}% | ${r.holdout.r5}% | ${r.holdout.r10}% | ${r.holdout.mrr} | ${r.holdout.book1}% |`);
lines.push("", `## Retrieval by question type (${shipped.name})`, "", "| type | n | R@1 | R@5 | R@10 | MRR | Book@1 |", "|---|---|---|---|---|---|---|");
const shippedRes = retrievalResults[retrievalResults.length - 1];
for (const t of TYPES) {
  const s = shippedRes.byType[t];
  lines.push(`| ${t} | ${s.n} | ${s.r1}% | ${s.r5}% | ${s.r10}% | ${s.mrr} | ${s.book1}% |`);
}
lines.push("", "## Misses at rank 1 (shipped config)", "", "| id | type | gold rank | top result |", "|---|---|---|---|");
for (const p of shippedPerQuestion.filter((p) => p.rank !== 1)) lines.push(`| ${p.id} | ${p.type} | ${p.rank ?? "not in top 10"} | ${p.top[0]} |`);
lines.push("", "## Extractive (no-key) answers", "", `Answer quotes a gold passage: ${extractiveHits}/${questions.length}`);
lines.push("", "## Grounding validator", "", `Planted fake quotes caught: **${validator.fakesCaught}/${validator.fakesTotal}**`, "", `Real quotes verified: **${validator.realPassed}/${validator.realTotal}**`, "");
lines.push("| case | expected | correct |", "|---|---|---|");
for (const c of categories) lines.push(`| ${c.category} | ${c.shouldPass ? "verified" : "flagged"} | ${c.correct}/${c.total} |`);
writeFileSync(join(outDir, "summary.md"), lines.join("\n") + "\n");
console.log(lines.join("\n"));

if (validator.fakesCaught !== validator.fakesTotal || validator.realPassed !== validator.realTotal) {
  console.error("\nvalidator eval failed:", JSON.stringify(validator.failures, null, 2));
  process.exit(1);
}
