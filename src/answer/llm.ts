// Cited answers from a model (Anthropic or OpenAI, plain fetch). The model
// must return JSON where every claim carries exact quotes from numbered
// passages. Quotes are validated; if any fail, the model gets one chance to
// fix them, and whatever still fails is shown as "unverified", never hidden.
import { fetchJson, UpstreamError } from "../http.js";
import type { Retrieved } from "../search/retrieve.js";
import { FAILURE_TEXT, validateAnswer, type Claim, type ValidationSummary } from "./validate.js";

export type ModelCall = (system: string, user: string) => Promise<string>;

export const SYSTEM_PROMPT = `You answer questions about classic novels using only the numbered passages you are given.

Reply with one JSON object and nothing else, in this shape:
{"not_found": false, "answer": [{"text": "One claim, in your own words.", "citations": [{"passage": "P2", "quote": "words copied exactly from P2"}]}]}

Rules:
- Every claim needs at least one citation. A quote must be copied character for character from the passage it cites, 4 to 40 words long.
- To skip words inside a quote, write "..." in their place. Each part must still be exact.
- Use only facts the passages state. Do not use outside knowledge of the books.
- Two to four claims is usually enough. Keep each claim to one or two sentences.
- If the passages do not answer the question, reply {"not_found": true, "answer": []}.`;

export function formatPassages(passages: Retrieved[], titles: Map<string, string>): string {
  return passages
    .map((p, i) => `[P${i + 1}] ${titles.get(p.chunk.book) ?? p.chunk.book}, ${p.chunk.chapterTitle}\n${p.chunk.text}`)
    .join("\n\n");
}

interface ModelJson {
  not_found?: boolean;
  answer?: { text?: unknown; citations?: { passage?: unknown; quote?: unknown }[] }[];
}

/** Parse the model's reply into claims, mapping "P3" to chunk ids. Throws on unusable output. */
export function parseModelReply(reply: string, passages: Retrieved[]): { notFound: boolean; claims: Claim[] } {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) throw new UpstreamError("bad_response", "model", undefined, "no JSON object in reply");
  let json: ModelJson;
  try {
    json = JSON.parse(reply.slice(start, end + 1)) as ModelJson;
  } catch {
    throw new UpstreamError("bad_response", "model", undefined, "reply was not valid JSON");
  }
  const claims: Claim[] = [];
  for (const a of json.answer ?? []) {
    if (typeof a?.text !== "string" || !a.text.trim()) continue;
    const citations = (a.citations ?? [])
      .filter((c) => typeof c?.quote === "string" && typeof c?.passage === "string")
      .map((c) => {
        const n = Number.parseInt(String(c.passage).replace(/\D/g, ""), 10);
        // An out-of-range label maps to a fake id, which the validator rejects as "not retrieved".
        const passageId = passages[n - 1]?.chunk.id ?? `unknown:${String(c.passage)}`;
        return { passageId, quote: String(c.quote) };
      });
    claims.push({ text: a.text.trim(), citations });
  }
  return { notFound: json.not_found === true && claims.length === 0, claims };
}

export interface LlmAnswer {
  notFound: boolean;
  validation: ValidationSummary;
  regenerated: boolean;
  /** Validation of the first attempt, kept when a retry happened. */
  firstAttempt?: { verified: number; total: number };
  calls: number;
}

export async function answerWithModel(
  question: string,
  passages: Retrieved[],
  titles: Map<string, string>,
  call: ModelCall,
  opts: { allowRetry: () => boolean } = { allowRetry: () => true },
): Promise<LlmAnswer> {
  const passageText = new Map(passages.map((p) => [p.chunk.id, p.chunk.text]));
  const user = `Passages:\n\n${formatPassages(passages, titles)}\n\nQuestion: ${question}`;

  const reply = await call(SYSTEM_PROMPT, user);
  const first = parseModelReply(reply, passages);
  const v1 = validateAnswer(first.claims, passageText);
  const ok = v1.verified === v1.total && v1.uncited === 0;
  if (ok || first.notFound || !opts.allowRetry()) {
    return { notFound: first.notFound, validation: v1, regenerated: false, calls: 1 };
  }

  const label = new Map(passages.map((p, i) => [p.chunk.id, `P${i + 1}`]));
  const problems = v1.claims.flatMap((c) =>
    c.citations.length === 0
      ? [`- The claim "${c.text}" has no citation.`]
      : c.citations
          .filter((q) => !q.verified)
          .map((q) => `- "${q.quote}" (cited as ${label.get(q.passageId) ?? "an unknown passage"}): ${FAILURE_TEXT[q.reason!]}.`),
  );
  const retryUser = `${user}\n\nYour previous reply was:\n${reply}\n\nThese problems were found:\n${problems.join("\n")}\n\nReply again with the full JSON. Copy quotes exactly from the passage you cite, or drop the claim.`;
  try {
    const second = parseModelReply(await call(SYSTEM_PROMPT, retryUser), passages);
    const v2 = validateAnswer(second.claims, passageText);
    return {
      notFound: second.notFound,
      validation: v2,
      regenerated: true,
      firstAttempt: { verified: v1.verified, total: v1.total },
      calls: 2,
    };
  } catch (e) {
    // The retry failed outright; the first answer, with its flags, is still worth showing.
    console.warn(`regeneration failed: ${(e as Error).message}`);
    return { notFound: first.notFound, validation: v1, regenerated: false, calls: 2 };
  }
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export function anthropicCall(apiKey: string, model: string, timeoutMs: number, onUsage?: (u: Usage) => void): ModelCall {
  return async (system, user) => {
    const json = await fetchJson<{ content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } }>(
      "https://api.anthropic.com/v1/messages",
      {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        // No temperature: current Claude models reject sampling overrides.
        body: { model, max_tokens: 1200, system, messages: [{ role: "user", content: user }] },
        timeoutMs,
        provider: "Anthropic",
      },
    );
    onUsage?.({ inputTokens: json.usage?.input_tokens ?? 0, outputTokens: json.usage?.output_tokens ?? 0 });
    const text = json.content?.find((c) => c.type === "text")?.text;
    if (!text) throw new UpstreamError("bad_response", "Anthropic", undefined, "no text content");
    return text;
  };
}

export function openaiCall(apiKey: string, model: string, timeoutMs: number, onUsage?: (u: Usage) => void): ModelCall {
  return async (system, user) => {
    const json = await fetchJson<{ choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }>("https://api.openai.com/v1/chat/completions", {
      headers: { authorization: `Bearer ${apiKey}` },
      body: {
        model,
        temperature: 0,
        max_tokens: 1200,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      },
      timeoutMs,
      provider: "OpenAI",
    });
    onUsage?.({ inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 });
    const text = json.choices?.[0]?.message?.content;
    if (!text) throw new UpstreamError("bad_response", "OpenAI", undefined, "no message content");
    return text;
  };
}
