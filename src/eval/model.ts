// npm run eval:model
//
// The model path, measured. Needs ANTHROPIC_API_KEY (or OPENAI_API_KEY).
// Every question in evals/questions.json and evals/holdout.json goes through
// the real pipeline (retrieve, model answer, validate, one retry), and this
// records what the validator saw:
//
//   - how often every quote in the first reply passed the check
//   - how often a retry was needed, and what it fixed
//   - how often a verified quote came from a gold passage (the question's own
//     answer) when retrieval had found one
//   - not_found rate, calls, tokens, cost and latency
//
// Writes evals/results/model-<model>.json and model-<model>.md. Nothing here
// changes retrieval or the validator; it only watches them with a model on.
//
//   npm run eval:model -- --limit 5     a quick look
//   ANTHROPIC_MODEL=claude-haiku-4-5 npm run eval:model
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Asker, DailyCounter } from "../answer/ask.js";
import { anthropicCall, openaiCall, type Usage } from "../answer/llm.js";
import { normalize } from "../answer/validate.js";
import { loadConfig } from "../config.js";
import { Library, ROOT } from "../library.js";

interface Question {
  id: string;
  type: string;
  book: string;
  question: string;
  gold: string[];
}

// USD per million tokens, input and output. Unknown models get no cost, not a wrong one.
const PRICES: Record<string, [number, number]> = {
  "claude-haiku-4-5": [1, 5],
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-sonnet-5-5": [2, 10],
  "gpt-4.1-mini": [0.4, 1.6],
};

const args = process.argv.slice(2);
const limitArg = args.indexOf("--limit");
const limit = limitArg >= 0 ? Number.parseInt(args[limitArg + 1], 10) : Infinity;

const cfg = loadConfig();
if (!cfg.anthropicKey && !cfg.openaiKey) {
  console.error("Set ANTHROPIC_API_KEY or OPENAI_API_KEY. This eval exists to measure the model path.");
  process.exit(2);
}
const usage: Usage = { inputTokens: 0, outputTokens: 0 };
const addUsage = (u: Usage) => {
  usage.inputTokens += u.inputTokens;
  usage.outputTokens += u.outputTokens;
};
const model = cfg.anthropicKey
  ? { provider: "anthropic" as const, name: cfg.anthropicModel, call: anthropicCall(cfg.anthropicKey, cfg.anthropicModel, cfg.llmTimeoutMs, addUsage) }
  : { provider: "openai" as const, name: cfg.openaiModel, call: openaiCall(cfg.openaiKey!, cfg.openaiModel, cfg.llmTimeoutMs, addUsage) };

const lib = Library.fromDir();
// BM25 only, like the deployed demo without an OpenAI key. The budget is lifted so nothing falls back.
const asker = new Asker(lib, cfg, { model, embedQuery: undefined, budget: new DailyCounter(1_000_000) });

const load = (f: string) => (JSON.parse(readFileSync(join(ROOT, "evals", f), "utf8")) as { questions: Question[] }).questions;
const sets: { set: string; questions: Question[] }[] = [
  { set: "questions", questions: load("questions.json") },
  { set: "holdout", questions: load("holdout.json") },
];
const isGold = (q: Question, chunk: { book: string; text: string }) => chunk.book === q.book && q.gold.some((g) => normalize(chunk.text).includes(normalize(g)));

interface Row {
  set: string;
  id: string;
  type: string;
  mode: "model" | "extractive";
  notice?: string;
  notFound: boolean;
  claims: number;
  uncited: number;
  /** quotes verified / quotes total in the reply the visitor sees */
  verified: number;
  total: number;
  /** the same for the first reply, when a retry happened */
  firstVerified: number;
  firstTotal: number;
  regenerated: boolean;
  goldRetrieved: boolean;
  goldCited: boolean;
  unverifiedReasons: string[];
  ms: number;
}

const rows: Row[] = [];
let n = 0;
for (const { set, questions } of sets) {
  for (const q of questions) {
    if (n++ >= limit) break;
    const t0 = performance.now();
    const r = await asker.ask({ question: q.question });
    const ms = Math.round(performance.now() - t0);
    const a = r.answer;
    const goldIds = new Set(r.retrieval.passages.filter((p) => isGold(q, { book: p.book, text: p.text })).map((p) => p.id));
    const row: Row = {
      set,
      id: q.id,
      type: q.type,
      mode: a.mode,
      notice: a.notice,
      notFound: a.notFound,
      claims: a.claims.length,
      uncited: a.claims.filter((c) => c.citations.length === 0).length,
      verified: a.verified,
      total: a.total,
      firstVerified: a.firstAttempt?.verified ?? a.verified,
      firstTotal: a.firstAttempt?.total ?? a.total,
      regenerated: a.regenerated,
      goldRetrieved: goldIds.size > 0,
      goldCited: a.claims.some((c) => c.citations.some((x) => x.verified && goldIds.has(x.passageId))),
      unverifiedReasons: a.claims.flatMap((c) => c.citations.filter((x) => !x.verified).map((x) => x.reason ?? "unknown")),
      ms,
    };
    rows.push(row);
    const flag = row.mode !== "model" ? "FALLBACK" : row.notFound ? "not_found" : `${row.verified}/${row.total}${row.regenerated ? ` (retry, first ${row.firstVerified}/${row.firstTotal})` : ""}`;
    console.log(`${set}/${q.id} [${q.type}] ${flag} gold ${row.goldRetrieved ? (row.goldCited ? "cited" : "retrieved, not cited") : "not retrieved"} ${ms}ms`);
  }
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "n/a");
const modelRows = rows.filter((r) => r.mode === "model");
const answered = modelRows.filter((r) => !r.notFound);
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const firstTotal = sum(answered.map((r) => r.firstTotal));
const firstVerified = sum(answered.map((r) => r.firstVerified));
const finalTotal = sum(answered.map((r) => r.total));
const finalVerified = sum(answered.map((r) => r.verified));
const cleanFirst = answered.filter((r) => !r.regenerated && r.verified === r.total && r.uncited === 0).length;
const retried = answered.filter((r) => r.regenerated);
const fixedByRetry = retried.filter((r) => r.verified === r.total).length;
const withGold = answered.filter((r) => r.goldRetrieved);
const goldCited = withGold.filter((r) => r.goldCited).length;
const sortedMs = rows.map((r) => r.ms).sort((a, b) => a - b);
const p = (k: number) => sortedMs[Math.min(sortedMs.length - 1, Math.floor(sortedMs.length * k))] ?? 0;
const price = PRICES[model.name];
const cost = price ? (usage.inputTokens * price[0] + usage.outputTokens * price[1]) / 1_000_000 : null;
const reasons = new Map<string, number>();
for (const r of answered) for (const x of r.unverifiedReasons) reasons.set(x, (reasons.get(x) ?? 0) + 1);

const summary = {
  model: model.name,
  provider: model.provider,
  date: new Date().toISOString().slice(0, 10),
  questions: rows.length,
  modelAnswers: modelRows.length,
  fallbacks: rows.length - modelRows.length,
  notFound: modelRows.length - answered.length,
  quotesFirstReply: { verified: firstVerified, total: firstTotal },
  quotesFinal: { verified: finalVerified, total: finalTotal },
  answersCleanFirstTry: cleanFirst,
  answersRetried: retried.length,
  retriesThatFixedEverything: fixedByRetry,
  answersWithUnverifiedShown: answered.filter((r) => r.verified < r.total).length,
  goldRetrieved: withGold.length,
  goldCitedWhenRetrieved: goldCited,
  unverifiedReasons: Object.fromEntries(reasons),
  usage,
  costUsd: cost === null ? null : Math.round(cost * 10000) / 10000,
  latencyMs: { p50: p(0.5), p95: p(0.95) },
};

const byType = [...new Set(answered.map((r) => r.type))].map((type) => {
  const rs = answered.filter((r) => r.type === type);
  return { type, n: rs.length, firstTry: pct(sum(rs.map((r) => r.firstVerified)), sum(rs.map((r) => r.firstTotal))), final: pct(sum(rs.map((r) => r.verified)), sum(rs.map((r) => r.total))), goldCited: pct(rs.filter((r) => r.goldCited).length, rs.filter((r) => r.goldRetrieved).length) };
});

const outDir = join(ROOT, "evals/results");
mkdirSync(outDir, { recursive: true });
const slug = model.name.replace(/[^a-z0-9.-]/gi, "_");
writeFileSync(join(outDir, `model-${slug}.json`), JSON.stringify({ summary, byType, rows }, null, 2));

const md = [
  `# Model path: ${model.name} (${summary.date})`,
  "",
  `Every question in evals/questions.json and evals/holdout.json, through the real pipeline with \`${model.name}\` writing the answer. BM25 retrieval, 8 passages, one retry allowed. Produced by \`npm run eval:model\`.`,
  "",
  "| | |",
  "| --- | --- |",
  `| Questions | ${summary.questions} (${summary.fallbacks} fell back to extractive) |`,
  `| Model said not found | ${summary.notFound} |`,
  `| Quotes verified in the first reply | ${firstVerified} of ${firstTotal} (${pct(firstVerified, firstTotal)}) |`,
  `| Answers clean on the first try (every quote verified, every claim cited) | ${cleanFirst} of ${answered.length} (${pct(cleanFirst, answered.length)}) |`,
  `| Answers that needed the retry | ${retried.length}, of which the retry fixed everything in ${fixedByRetry} |`,
  `| Quotes verified in the answer shown | ${finalVerified} of ${finalTotal} (${pct(finalVerified, finalTotal)}) |`,
  `| Answers shown with an unverified quote | ${summary.answersWithUnverifiedShown} |`,
  `| Gold passage retrieved | ${withGold.length} of ${answered.length} |`,
  `| ...and a verified quote came from it | ${goldCited} of ${withGold.length} (${pct(goldCited, withGold.length)}) |`,
  `| Tokens | ${usage.inputTokens.toLocaleString()} in, ${usage.outputTokens.toLocaleString()} out |`,
  `| Cost | ${cost === null ? "n/a (model not in the price table)" : `$${cost.toFixed(4)}`} |`,
  `| Latency | p50 ${summary.latencyMs.p50} ms, p95 ${summary.latencyMs.p95} ms (retrieve + model + check) |`,
  "",
  "## By question type",
  "",
  "| Type | n | Quotes verified, first reply | Quotes verified, shown | Gold cited when retrieved |",
  "| --- | --- | --- | --- | --- |",
  ...byType.map((t) => `| ${t.type} | ${t.n} | ${t.firstTry} | ${t.final} | ${t.goldCited} |`),
  "",
  "## Why quotes failed",
  "",
  ...(reasons.size ? [...reasons].map(([k, v]) => `- ${v}: ${k}`) : ["- none"]),
  "",
  "The gold-cited number is bounded by retrieval: the model can only quote a gold passage that BM25 put in its eight. Quotes that fail are shown to the visitor as unverified, never dropped, so the \"shown\" row is what a visitor would see.",
  "",
];
writeFileSync(join(outDir, `model-${slug}.md`), md.join("\n"));
console.log(`\n${md.slice(4, 18).join("\n")}\n\nwrote evals/results/model-${slug}.{json,md}`);
