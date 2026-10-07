// Every setting comes from the environment. See .env.example.
const int = (v: string | undefined, d: number) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    port: int(env.PORT, 3000),
    anthropicKey: env.ANTHROPIC_API_KEY || undefined,
    anthropicModel: env.ANTHROPIC_MODEL || "claude-haiku-4-5",
    openaiKey: env.OPENAI_API_KEY || undefined,
    openaiModel: env.OPENAI_MODEL || "gpt-4.1-mini",
    embeddingModel: env.EMBEDDING_MODEL || "text-embedding-3-small",
    /** LLM answers per UTC day across all visitors. Past this, answers fall back to extractive mode. */
    dailyLlmLimit: int(env.DAILY_LLM_LIMIT, 200),
    /** /api/ask requests per IP per minute. */
    askPerMinute: int(env.ASK_PER_MINUTE, 12),
    llmTimeoutMs: int(env.LLM_TIMEOUT_MS, 25_000),
    /** Set to 1 behind a proxy you trust (Render, Vercel) to read the client IP from X-Forwarded-For. */
    trustProxy: env.TRUST_PROXY === "1" || env.RENDER === "true",
  };
}

export type Config = ReturnType<typeof loadConfig>;
