import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicCall, answerWithModel, openaiCall, parseModelReply, SYSTEM_PROMPT } from "../src/answer/llm.js";
import { UpstreamError } from "../src/http.js";
import { Library } from "../src/library.js";
import { retrieve } from "../src/search/retrieve.js";
import { TINY } from "./fixtures.js";

const lib = new Library(structuredClone(TINY));
const titles = new Map([...lib.books.values()].map((b) => [b.slug, b.title]));
const passagesFor = async (q: string) => (await retrieve(lib, q, { k: 3 })).passages;

const reply = (claims: { text: string; passage: string; quote: string }[]) =>
  JSON.stringify({ not_found: false, answer: claims.map((c) => ({ text: c.text, citations: [{ passage: c.passage, quote: c.quote }] })) });

afterEach(() => vi.unstubAllGlobals());

describe("parseModelReply", () => {
  it("maps passage labels to chunk ids and tolerates text around the JSON", async () => {
    const ps = await passagesFor("captain white whale");
    const out = parseModelReply(`Here you go:\n${reply([{ text: "x", passage: "P1", quote: "q" }])}\nThanks`, ps);
    expect(out.claims[0].citations[0].passageId).toBe(ps[0].chunk.id);
  });

  it("maps an out-of-range label to an id the validator will reject", async () => {
    const ps = await passagesFor("captain white whale");
    const out = parseModelReply(reply([{ text: "x", passage: "P9", quote: "q" }]), ps);
    expect(out.claims[0].citations[0].passageId).toBe("unknown:P9");
  });

  it("throws on a reply with no JSON", async () => {
    expect(() => parseModelReply("I cannot help with that.", [])).toThrow(UpstreamError);
  });
});

describe("answerWithModel", () => {
  it("returns a fully verified answer without a retry", async () => {
    const ps = await passagesFor("Why was the captain angry at the white whale?");
    const call = vi.fn(async () => reply([{ text: "The captain was angry.", passage: "P1", quote: "the captain was angry" }]));
    const r = await answerWithModel("q", ps, titles, call);
    expect(call).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ regenerated: false, validation: { verified: 1, total: 1 } });
  });

  it("asks once more when a quote is invented, and keeps the fixed answer", async () => {
    const ps = await passagesFor("Why was the captain angry at the white whale?");
    const call = vi
      .fn()
      .mockResolvedValueOnce(reply([{ text: "He hated it.", passage: "P1", quote: "the captain swore eternal revenge" }]))
      .mockResolvedValueOnce(reply([{ text: "He hated it.", passage: "P1", quote: "the captain was angry" }]));
    const r = await answerWithModel("q", ps, titles, call);
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1][1]).toContain("the captain swore eternal revenge");
    expect(call.mock.calls[1][1]).toContain("not found in the cited passage");
    expect(r).toMatchObject({ regenerated: true, firstAttempt: { verified: 0, total: 1 }, validation: { verified: 1, total: 1 } });
  });

  it("flags quotes that are still wrong after the retry instead of hiding them", async () => {
    const ps = await passagesFor("Why was the captain angry at the white whale?");
    const bad = reply([{ text: "He hated it.", passage: "P1", quote: "the captain swore eternal revenge" }]);
    const r = await answerWithModel("q", ps, titles, vi.fn(async () => bad));
    expect(r.validation.verified).toBe(0);
    expect(r.validation.claims[0].citations[0]).toMatchObject({ verified: false, reason: "not_found" });
  });

  it("does not retry when the budget says no", async () => {
    const ps = await passagesFor("captain");
    const call = vi.fn(async () => reply([{ text: "x", passage: "P1", quote: "words that are not there" }]));
    const r = await answerWithModel("q", ps, titles, call, { allowRetry: () => false });
    expect(call).toHaveBeenCalledTimes(1);
    expect(r.regenerated).toBe(false);
  });
});

describe("provider requests", () => {
  it("sends the Anthropic Messages API shape", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: "text", text: "{}" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await anthropicCall("key", "claude-haiku-4-5", 1000)(SYSTEM_PROMPT, "hello");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "claude-haiku-4-5", system: SYSTEM_PROMPT, messages: [{ role: "user", content: "hello" }] });
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it("sends the OpenAI Chat Completions shape with JSON mode", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await openaiCall("key", "gpt-4.1-mini", 1000)("sys", "hello");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer key");
    expect(JSON.parse(String(init.body))).toMatchObject({ response_format: { type: "json_object" }, messages: [{ role: "system" }, { role: "user" }] });
  });

  it.each([
    [401, "auth"],
    [429, "rate_limit"],
    [503, "upstream"],
  ])("turns HTTP %i into a %s error", async (status, kind) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status })));
    await expect(anthropicCall("k", "m", 1000)("s", "u")).rejects.toMatchObject({ kind });
  });

  it("times out slow responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason)))),
    );
    await expect(openaiCall("k", "m", 20)("s", "u")).rejects.toMatchObject({ kind: "timeout" });
  });
});
