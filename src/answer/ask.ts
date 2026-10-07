// The question-answering pipeline behind /api/ask: retrieve, answer (model or
// extractive), validate, and package everything the UI needs to show how the
// answer was made.
import type { Config } from "../config.js";
import { UpstreamError } from "../http.js";
import type { Library } from "../library.js";
import { retrieve, type Retrieval } from "../search/retrieve.js";
import { embed } from "../search/vectors.js";
import { extractiveClaims } from "./extractive.js";
import { anthropicCall, answerWithModel, openaiCall, type ModelCall } from "./llm.js";
import { FAILURE_TEXT, validateAnswer, type ValidationSummary } from "./validate.js";

export const MAX_QUESTION_CHARS = 400;
export const PASSAGES_FOR_ANSWER = 8;

/** Counts model calls per UTC day. In memory: a restart resets it, which errs toward fewer calls only within one process. */
export class DailyCounter {
  private day = "";
  private n = 0;
  constructor(
    readonly limit: number,
    private readonly now: () => Date = () => new Date(),
  ) {}
  private roll() {
    const d = this.now().toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.n = 0;
    }
  }
  canSpend(): boolean {
    this.roll();
    return this.n < this.limit;
  }
  /** Returns false (and does not count) when the limit is reached. */
  take(): boolean {
    if (!this.canSpend()) return false;
    this.n++;
    return true;
  }
  get used() {
    this.roll();
    return this.n;
  }
}

export interface AskInput {
  question: string;
  books?: string[];
}

export class Asker {
  readonly model?: { provider: "anthropic" | "openai"; name: string; call: ModelCall };
  readonly embedQuery?: (q: string) => Promise<Float32Array>;
  readonly budget: DailyCounter;
  private readonly titles: Map<string, string>;

  constructor(
    readonly lib: Library,
    readonly cfg: Config,
    overrides: { model?: Asker["model"]; embedQuery?: Asker["embedQuery"]; budget?: DailyCounter } = {},
  ) {
    this.titles = new Map([...lib.books.values()].map((b) => [b.slug, b.title]));
    this.budget = overrides.budget ?? new DailyCounter(cfg.dailyLlmLimit);
    if (overrides.model) this.model = overrides.model;
    else if (cfg.anthropicKey)
      this.model = { provider: "anthropic", name: cfg.anthropicModel, call: anthropicCall(cfg.anthropicKey, cfg.anthropicModel, cfg.llmTimeoutMs) };
    else if (cfg.openaiKey)
      this.model = { provider: "openai", name: cfg.openaiModel, call: openaiCall(cfg.openaiKey, cfg.openaiModel, cfg.llmTimeoutMs) };

    if (overrides.embedQuery) this.embedQuery = overrides.embedQuery;
    else if (cfg.openaiKey && lib.vectors) {
      const key = cfg.openaiKey;
      this.embedQuery = async (q) => (await embed([q], { apiKey: key, model: lib.vectors!.meta.model, timeoutMs: 8000 }))[0];
    }
  }

  get retrievalMethod(): "bm25" | "hybrid" {
    return this.lib.vectors && this.embedQuery ? "hybrid" : "bm25";
  }

  async ask(input: AskInput) {
    const t0 = performance.now();
    const retrieval = await retrieve(this.lib, input.question, {
      k: PASSAGES_FOR_ANSWER,
      books: input.books,
      embedQuery: this.embedQuery,
    });
    const t1 = performance.now();

    let mode: "model" | "extractive" = "extractive";
    let notice: string | undefined;
    let notFound = false;
    let regenerated = false;
    let firstAttempt: { verified: number; total: number } | undefined;
    let validation: ValidationSummary | undefined;
    let highlights: { passageId: string; start: number; end: number }[] = [];

    if (!retrieval.passages.length) {
      notFound = true;
      validation = validateAnswer([], new Map());
    } else if (this.model && this.budget.take()) {
      try {
        const r = await answerWithModel(input.question, retrieval.passages, this.titles, this.model.call, {
          allowRetry: () => this.budget.take(),
        });
        mode = "model";
        notFound = r.notFound;
        regenerated = r.regenerated;
        firstAttempt = r.firstAttempt;
        validation = r.validation;
      } catch (e) {
        console.warn(`model answer failed: ${(e as Error).message}`);
        notice = e instanceof UpstreamError ? e.publicMessage : "The model had a problem, so this answer was made without a model.";
      }
    } else if (this.model) {
      notice = "Today's model budget for this demo is used up, so this answer was made without a model. It resets at midnight UTC.";
    }

    if (!validation) {
      const ex = extractiveClaims(input.question, retrieval.passages, this.lib.bm25);
      const passageText = new Map(retrieval.passages.map((p) => [p.chunk.id, p.chunk.text]));
      validation = validateAnswer(ex.claims, passageText);
      notFound = ex.claims.length === 0;
      highlights = ex.sentences.map((s) => ({ passageId: s.passageId, start: s.start, end: s.end }));
    }
    const t2 = performance.now();

    return {
      question: input.question,
      books: input.books ?? [],
      answer: {
        mode,
        model: mode === "model" ? this.model!.name : undefined,
        notFound,
        notice,
        regenerated,
        firstAttempt,
        verified: validation.verified,
        total: validation.total,
        claims: validation.claims.map((c) => ({
          text: c.text,
          citations: c.citations.map((q) => ({
            n: retrieval.passages.findIndex((p) => p.chunk.id === q.passageId) + 1 || null,
            passageId: q.passageId,
            quote: q.quote,
            verified: q.verified,
            reason: q.reason ? FAILURE_TEXT[q.reason] : undefined,
            foundIn: q.foundIn ? retrieval.passages.findIndex((p) => p.chunk.id === q.foundIn) + 1 : undefined,
            pieces: q.pieces,
          })),
        })),
        highlights,
      },
      retrieval: this.describeRetrieval(retrieval),
      timings: { retrieveMs: Math.round(t1 - t0), answerMs: Math.round(t2 - t1) },
    };
  }

  private describeRetrieval(r: Retrieval) {
    return {
      method: r.method,
      namedBooks: r.namedBooks,
      note: r.note,
      passages: r.passages.map((p, i) => ({
        n: i + 1,
        id: p.chunk.id,
        book: p.chunk.book,
        bookTitle: this.titles.get(p.chunk.book),
        chapter: p.chunk.chapter,
        chapterTitle: p.chunk.chapterTitle,
        paraStart: p.chunk.paraStart,
        paraEnd: p.chunk.paraEnd,
        line: p.chunk.line,
        text: p.chunk.text,
        score: round(p.score),
        bm25Score: p.bm25Score === null ? null : round(p.bm25Score),
        bm25Rank: p.bm25Rank,
        vectorScore: p.vectorScore === null ? null : round(p.vectorScore),
        vectorRank: p.vectorRank,
        readUrl: readUrl(p.chunk.book, p.chunk.chapter, p.chunk.paraStart, p.chunk.paraEnd),
      })),
    };
  }
}

const round = (x: number) => Math.round(x * 1000) / 1000;

export const readUrl = (book: string, chapter: number, from: number, to: number) =>
  `/read/${book}/${chapter + 1}?from=${from + 1}&to=${to + 1}#p${from + 1}`;

export type AskResult = Awaited<ReturnType<Asker["ask"]>>;
