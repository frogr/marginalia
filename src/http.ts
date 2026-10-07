// One JSON POST helper for the model APIs, with a timeout and errors that say
// what went wrong without leaking response bodies to visitors.

export type UpstreamKind = "auth" | "rate_limit" | "upstream" | "timeout" | "bad_response";

export class UpstreamError extends Error {
  constructor(
    readonly kind: UpstreamKind,
    readonly provider: string,
    readonly status?: number,
    detail?: string,
  ) {
    super(`${provider} ${kind}${status ? ` (HTTP ${status})` : ""}${detail ? `: ${detail}` : ""}`);
  }

  /** Safe to show a visitor. */
  get publicMessage(): string {
    switch (this.kind) {
      case "auth":
        return "The model API key was rejected, so this answer was made without a model.";
      case "rate_limit":
        return "The model API is rate limiting requests right now, so this answer was made without a model.";
      case "timeout":
        return "The model took too long to respond, so this answer was made without a model.";
      default:
        return "The model API had a problem, so this answer was made without a model.";
    }
  }
}

export async function fetchJson<T>(
  url: string,
  opts: { headers: Record<string, string>; body: unknown; timeoutMs: number; provider: string },
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...opts.headers },
      body: JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (e) {
    const name = (e as Error).name;
    if (name === "TimeoutError" || name === "AbortError") throw new UpstreamError("timeout", opts.provider);
    throw new UpstreamError("upstream", opts.provider, undefined, (e as Error).message);
  }
  if (res.status === 401 || res.status === 403) throw new UpstreamError("auth", opts.provider, res.status);
  if (res.status === 429) throw new UpstreamError("rate_limit", opts.provider, res.status);
  if (!res.ok) throw new UpstreamError("upstream", opts.provider, res.status, (await res.text().catch(() => "")).slice(0, 300));
  try {
    return (await res.json()) as T;
  } catch {
    throw new UpstreamError("bad_response", opts.provider, res.status, "response was not JSON");
  }
}
