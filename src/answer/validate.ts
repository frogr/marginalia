// The grounding validator. A quote counts as verified only if it appears in
// the passage it cites, and that passage was one of the passages retrieved
// for this question.
//
// Matching ignores differences that do not change the words: runs of
// whitespace, curly vs straight quote marks, dash styles ("—", "--", "-"),
// Gutenberg's _italic_ underscores, letter case, and punctuation or quote
// marks at the very start or end of the quote. An ellipsis ("..." or "…")
// splits a quote into pieces; every piece must be found, in order, in the same
// passage. Pieces shorter than two words are rejected because almost any
// passage contains them.

export interface PieceCheck {
  text: string;
  found: boolean;
  /** Offsets into the passage text (original, not normalized) when found. */
  start?: number;
  end?: number;
}

export type QuoteFailure = "empty" | "too_short" | "passage_not_retrieved" | "not_found" | "out_of_order";

export interface QuoteCheck {
  passageId: string;
  quote: string;
  verified: boolean;
  reason?: QuoteFailure;
  /** If not found in the cited passage, another retrieved passage that does contain it. */
  foundIn?: string;
  pieces: PieceCheck[];
}

const SINGLE = /[‘’‚‛′`´]/;
const DOUBLE = /[“”„‟″«»]/;
const DASH = /[-‐‑‒–—―−]/;

export interface Normalized {
  text: string;
  /** map[i] = index in the original string of normalized character i */
  map: number[];
}

export function normalizeWithMap(s: string): Normalized {
  // Built as an array of characters: string slicing in the loop would be quadratic on long texts.
  const out: string[] = [];
  const map: number[] = [];
  const last = () => out[out.length - 1];
  for (let i = 0; i < s.length; i++) {
    let c = s[i];
    if (c === "_") continue;
    if (/\s/.test(c)) {
      if (out.length && last() !== " " && last() !== "-") {
        out.push(" ");
        map.push(i);
      }
      continue;
    }
    if (DASH.test(c)) {
      // Any run of dashes, with or without spaces around it, becomes one "-".
      if (last() === " ") {
        out.pop();
        map.pop();
      }
      if (last() !== "-") {
        out.push("-");
        map.push(i);
      }
      continue;
    }
    if (c === "…") {
      out.push(".", ".", ".");
      map.push(i, i, i);
      continue;
    }
    if (SINGLE.test(c)) c = "'";
    else if (DOUBLE.test(c)) c = '"';
    out.push(c.toLowerCase());
    map.push(i);
  }
  if (last() === " ") {
    out.pop();
    map.pop();
  }
  return { text: out.join(""), map };
}

export const normalize = (s: string) => normalizeWithMap(s).text;

const EDGE = /^[\s"'.,;:!?()[\]-]+|[\s"'.,;:!?()[\]-]+$/g;

/** Split on ellipses and trim punctuation and quote marks from each piece's edges. */
export function quotePieces(quote: string): string[] {
  return quote
    .replace(/\[\s*(?:\.\s*){3}\]/g, "…")
    .split(/\s*(?:…|\.\s*\.\s*\.)\s*/)
    .map((p) => normalize(p).replace(EDGE, ""))
    .filter((p) => p.length > 0);
}

const wordCount = (s: string) => s.split(" ").filter(Boolean).length;

/** Find normalized `pieces` in order inside `passage`. Returns per-piece results in original offsets. */
function locate(pieces: string[], passage: string): { checks: PieceCheck[]; inOrder: boolean } {
  const n = normalizeWithMap(passage);
  let from = 0;
  let inOrder = true;
  const checks = pieces.map((p) => {
    let at = n.text.indexOf(p, from);
    if (at < 0) {
      at = n.text.indexOf(p);
      if (at >= 0) inOrder = false;
    }
    if (at < 0) return { text: p, found: false };
    from = at + p.length;
    return { text: p, found: true, start: n.map[at], end: n.map[at + p.length - 1] + 1 };
  });
  return { checks, inOrder };
}

export function checkQuote(quote: string, passageId: string, passages: Map<string, string>): QuoteCheck {
  const pieces = quotePieces(quote);
  const base = { passageId, quote };
  if (!pieces.length) return { ...base, verified: false, reason: "empty", pieces: [] };
  if (pieces.some((p) => wordCount(p) < 2) || pieces.reduce((n, p) => n + wordCount(p), 0) < 3) {
    return { ...base, verified: false, reason: "too_short", pieces: pieces.map((text) => ({ text, found: false })) };
  }
  const text = passages.get(passageId);
  if (text === undefined) {
    return { ...base, verified: false, reason: "passage_not_retrieved", pieces: pieces.map((t) => ({ text: t, found: false })) };
  }
  const { checks, inOrder } = locate(pieces, text);
  if (checks.every((c) => c.found)) {
    return inOrder ? { ...base, verified: true, pieces: checks } : { ...base, verified: false, reason: "out_of_order", pieces: checks };
  }
  let foundIn: string | undefined;
  for (const [id, t] of passages) {
    if (id === passageId) continue;
    const other = locate(pieces, t);
    if (other.inOrder && other.checks.every((c) => c.found)) {
      foundIn = id;
      break;
    }
  }
  return { ...base, verified: false, reason: "not_found", foundIn, pieces: checks };
}

export interface Claim {
  text: string;
  citations: { passageId: string; quote: string }[];
}

export interface CheckedClaim {
  text: string;
  citations: QuoteCheck[];
}

export interface ValidationSummary {
  claims: CheckedClaim[];
  verified: number;
  total: number;
  /** Claims that carry no citation at all. */
  uncited: number;
}

export function validateAnswer(claims: Claim[], passages: Map<string, string>): ValidationSummary {
  let verified = 0;
  let total = 0;
  let uncited = 0;
  const checked = claims.map((c) => {
    if (!c.citations.length) uncited++;
    const citations = c.citations.map((cit) => {
      const r = checkQuote(cit.quote, cit.passageId, passages);
      total++;
      if (r.verified) verified++;
      return r;
    });
    return { text: c.text, citations };
  });
  return { claims: checked, verified, total, uncited };
}

export const FAILURE_TEXT: Record<QuoteFailure, string> = {
  empty: "empty quote",
  too_short: "too short to verify (needs at least three words, two per piece)",
  passage_not_retrieved: "cites a passage that was not retrieved",
  not_found: "not found in the cited passage",
  out_of_order: "pieces found, but not in the quoted order",
};
