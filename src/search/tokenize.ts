import { stemmer } from "stemmer";

// A standard English stopword list, plus the fragments left over when
// contractions are split ("don't" -> "don", "t").
export const STOPWORDS = new Set(
  `a about above after again against all am an and any are as at be because been before being below between both but by
  can could did do does doing down during each few for from further had has have having he her here hers herself him
  himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other
  our ours ourselves out over own same she should so some such than that the their theirs them themselves then there
  these they this those through to too under until up very was we were what when where which while who whom why will
  with would you your yours yourself yourselves upon shall may might must also yet ever us one said s t d ll re ve m
  don didn doesn isn wasn weren won wouldn couldn shouldn hasn haven hadn aren ain o oh`.split(/\s+/),
);

/** Lowercase, strip accents, unify apostrophes. */
export function fold(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’‘`]/g, "'");
}

/** Lowercased words with possessive 's removed. Keeps stopwords. */
export function words(s: string): string[] {
  return fold(s).replace(/'s\b/g, "").match(/[a-z0-9]+/g) ?? [];
}

const stemCache = new Map<string, string>();
export function stem(w: string): string {
  let s = stemCache.get(w);
  if (s === undefined) {
    s = stemmer(w);
    if (stemCache.size < 200_000) stemCache.set(w, s);
  }
  return s;
}

/** Search terms: words minus stopwords, Porter-stemmed. */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const w of words(s)) if (!STOPWORDS.has(w)) out.push(stem(w));
  return out;
}
