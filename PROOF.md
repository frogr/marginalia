# Proof

What was checked, how, and what was not. Every number here comes from a command shown next to it, run on 2026-10-07 on Node 22.22.0.

## Corpus

```
$ npm run corpus
ok   pride-and-prejudice          chapters=61/61 paragraphs=2060 words=121571
ok   moby-dick                    chapters=136/136 paragraphs=2432 words=207804
ok   frankenstein                 chapters=28/28 paragraphs=764 words=74919
ok   dracula                      chapters=27/27 paragraphs=2092 words=160654
ok   jane-eyre                    chapters=38/38 paragraphs=4048 words=184376
ok   great-expectations           chapters=59/59 paragraphs=3835 words=184218
ok   the-great-gatsby             chapters=9/9 paragraphs=1635 words=48143
ok   alice-in-wonderland          chapters=12/12 paragraphs=798 words=26369
ok   the-picture-of-dorian-gray   chapters=20/20 paragraphs=1491 words=78503
ok   crime-and-punishment         chapters=41/41 paragraphs=3904 words=202615
ok   a-tale-of-two-cities         chapters=45/45 paragraphs=3269 words=135421
ok   little-women                 chapters=47/47 paragraphs=3815 words=185675
```

Each book has its own parse rules (`src/corpus/books.ts`) and an expected chapter count; the build fails if the parse finds a different number. The chunker produces 7,107 chunks; a test checks that every chunk's text equals `chapterText.slice(charStart, charEnd)`.

## Tests

```
$ npm test
 Test Files  6 passed (6)
      Tests  61 passed (61)
```

Re-run on 2026-10-07: 61 tests pass (earlier runs showed 60).

Covered: chunk offsets, chapter boundaries, overlap, long-paragraph splitting, sentence splitting around "Mr."; tokenizer, BM25 ranking, stemming, book filter, phrase and quote boosts, neighbor scores; RRF; hybrid retrieval with a stub embedder and the BM25 fallback when embedding fails; vector index loading and stale-index rejection; the validator (normalization, offsets, ellipses, order, wrong passage, unretrieved passage, too short); the model loop (retry on a bad quote, flags kept when the retry fails, no retry when the budget is spent); Anthropic, OpenAI and embeddings request shapes; 401, 429, 5xx and timeouts; and the routes (validation, 413, rate limit, model failure fallback, daily cap, passage, reader, static files and CSP header). `npm run typecheck` passes. No test touches the network.

## Retrieval eval

```
$ npm run eval
```

Writes `evals/results/summary.md`, `retrieval.json` and `validator.json`.

**Questions.** `evals/questions.json` has 46 questions in four types: direct (12, names and wording close to the text), paraphrased (12, wording deliberately different), name-free (10, no character names or titles) and cross-book (12, a name or idea that appears in more than one book, like Elizabeth in Pride and Prejudice and Frankenstein, or Pip in Great Expectations and Moby-Dick). Each has one or two gold snippets, found by searching the processed text, and the eval refuses to run if any snippet is missing from its book. A hit is any retrieved chunk from the gold book that contains a gold snippet. No book filter is used, so the retriever has to find the book too.

**Ablation.** Each row adds one change.

| config | chunks | R@1 | R@5 | R@10 | MRR | Book@1 |
|---|---|---|---|---|---|---|
| bm25 | 10054 | 30.4% | 52.2% | 56.5% | 0.392 | 89.1% |
| +phrase | 10054 | 34.8% | 50% | 56.5% | 0.416 | 89.1% |
| +title | 10054 | 34.8% | 50% | 56.5% | 0.416 | 89.1% |
| +240w chunks | 7107 | 28.3% | 56.5% | 63% | 0.397 | 84.8% |
| +neighbors (shipped) | 7107 | 34.8% | 58.7% | 65.2% | 0.452 | 84.8% |

"+title" changes nothing because no eval question names its book. It stays because people do ask "in Dracula, ...".

**By type (shipped):**

| type | n | R@1 | R@5 | R@10 | MRR | Book@1 |
|---|---|---|---|---|---|---|
| direct | 12 | 66.7% | 91.7% | 100% | 0.764 | 100% |
| paraphrased | 12 | 25% | 25% | 25% | 0.25 | 83.3% |
| name-free | 10 | 40% | 70% | 80% | 0.546 | 90% |
| cross-book | 12 | 8.3% | 50% | 58.3% | 0.265 | 66.7% |

## Error analysis and the change it led to

Every question the plain BM25 config missed was examined (`npm run eval:explain -- <ids> --baseline` prints the query terms, what the top chunks matched and where the gold chunk ranked). The misses fell into two groups.

**1. The answer sits one chunk away from the names.** A scene names its people and place, and the event comes a paragraph or two later, in a chunk that shares few or no words with the question:

```
$ npm run eval:explain -- x01 x03 d09 --baseline
x01: What did Victor find when he ran into the room on Elizabeth's wedding night?
  top 1: frankenstein:25:13 score=15.19 matched=[victor elizabeth wed night]
  gold: frankenstein:26:3 rank=unscored matched=[]
x03: How was Lucy finally put to rest in her tomb?
  gold: dracula:15:21 rank=unscored matched=[]
d09: How does Raskolnikov strike the old pawnbroker with the axe?
  gold: crime-and-punishment:6:4 rank=24 matched=[old ax]
```

The gold chunk for x01 ("She was there, lifeless and inanimate, thrown across the bed") matches none of the question's terms, so BM25 cannot score it at all.

**2. Pure paraphrase.** The question and the text share almost no words:

```
p01: What advice did Nick's dad give him about judging other people?
  gold: the-great-gatsby:0:0 rank=87 matched=[advic peopl]
n10: An escaped convict in a churchyard grabs a small boy. What does he order the boy to bring him?
  gold: great-expectations:0:5 rank=898 matched=[bring]
```

The text says "criticizing anyone" and "my father", and "You get me a file ... wittles". No keyword trick fixes this without overfitting. This is what the optional vector search is for.

**The change**, aimed at group 1: chunks of about 240 words instead of 160, so more scenes keep their names and their event together, and each chunk gets 0.3 times its best same-chapter neighbor's BM25 score, so the event chunk shares in the match of the chunk that names the characters.

| | R@1 | R@5 | R@10 | MRR |
|---|---|---|---|---|
| Before (bm25+phrase+title, 160-word chunks) | 34.8% | 50% | 56.5% | 0.416 |
| After (shipped) | 34.8% | 58.7% | 65.2% | 0.452 |

After the change, x01's gold chunk is scored (rank 29, from unscored) and d09's is rank 6 (from 24), but neither reaches rank 1, and x03 is still far down. Group 2 did not move: paraphrased R@10 is 25% before and after.

**Held-out check.** The weights above were picked by looking at these same 46 questions, so they could be overfit. After freezing them, 12 new questions were added (`evals/holdout.json`, 3 per type) and every config was run on them:

| config | R@1 | R@5 | R@10 | MRR | Book@1 |
|---|---|---|---|---|---|
| bm25 | 25% | 58.3% | 58.3% | 0.354 | 66.7% |
| +phrase | 33.3% | 58.3% | 58.3% | 0.394 | 66.7% |
| +title | 33.3% | 58.3% | 58.3% | 0.394 | 66.7% |
| +240w chunks | 50% | 50% | 58.3% | 0.514 | 83.3% |
| +neighbors (shipped) | 41.7% | 58.3% | 58.3% | 0.475 | 83.3% |

On held-out questions the shipped config beats plain BM25 on MRR (0.475 vs 0.354) and R@1, with the same R@10. The neighbor step alone did slightly worse than bigger chunks alone here (0.475 vs 0.514 MRR). With 12 questions that is one question's difference, so treat it as a wash, not a result. All of these sets are small: one question is 2.2 points on the 46 and 8.3 points on the 12.

## Extractive answers

With no key, the answer is the three best-matching sentences from the top five passages. On the 46 questions, the extractive answer quotes a gold passage for 22 (from `npm run eval`). It cannot do better than retrieval: the gold passage is in the top five for 27.

## Grounding validator

`npm run eval` also plants fake quotes. For each of the 46 questions it takes the passages actually retrieved and builds real quotes that must pass and fakes that must fail:

| case | expected | correct |
|---|---|---|
| real: exact sentence | verified | 46/46 |
| real: quote marks, dashes and spacing restyled | verified | 46/46 |
| real: ellipsis between two exact pieces | verified | 44/44 |
| fake: invented sentence | flagged | 46/46 |
| fake: one word changed | flagged | 46/46 |
| fake: real quote, wrong passage cited | flagged | 46/46 |
| fake: real piece ... invented piece | flagged | 46/46 |
| fake: real pieces in the wrong order | flagged | 44/44 |
| fake: real text from a passage that was not retrieved | flagged | 46/46 |
| fake: too short to mean anything | flagged | 46/46 |

Fakes caught: **320/320**. Real quotes verified: **136/136**. The eval exits non-zero if either drops below 100%, so CI catches a regression.

What the validator does not catch: a real quote attached to a claim it does not support. It proves the words are in the book, not that the claim follows from them. The "how this answer was made" panel exists so a reader can check that part.

## Production build

```
$ npm run build && PORT=3124 npm start
loaded 12 books, 7107 chunks in 1844 ms; retrieval=bm25, answers=extractive, daily model limit=200

$ curl -s localhost:3124/health
{"ok":true,"books":12,"chunks":7107,"retrieval":"bm25","answers":"extractive","modelCallsToday":0,"dailyLlmLimit":200}

$ curl -s -X POST localhost:3124/api/ask -H 'content-type: application/json' \
    -d '{"question":"What did the Queen use for croquet mallets and balls?"}'
extractive verified 3/3 top alice-in-wonderland:7:4 { retrieveMs: 143, answerMs: 8 }

$ for i in $(seq 1 13); do curl ... /api/ask; done
200 200 200 200 200 200 200 200 200 200 200 429 429
```

(The rate limit is 12 per minute; one request had already been made.) `npm audit`: 0 vulnerabilities.

## Screenshots

Taken with Playwright against the built server (`npm run build && npm run screenshots`), no API keys:

- `docs/screenshots/home.png` (1280x800)
- `docs/screenshots/answer.png` (1280x800): extractive answer, citation expanded, quote highlighted
- `docs/screenshots/how-it-was-made.png` (1280x800): retrieved passages and scores
- `docs/screenshots/reader.png` (1280x800): chapter page with cited paragraphs marked
- `docs/screenshots/phone.png` (390x844)

## Not verified

- **Live model answers.** No API keys were available. The Anthropic and OpenAI request shapes, JSON parsing, retry loop and error handling are tested with mocked `fetch`, but no real model has answered a question. How often a real model's quotes pass the validator on the first try is unknown.
- **Hybrid retrieval.** `npm run embed` and query embedding are tested with mocks only. No embeddings were built, so there are no hybrid eval numbers. The paraphrased-question gap is where it should help most, and that is the first thing to measure once a key is available.
- **Render deploy.** `render.yaml` follows the Blueprint format and the build and start commands were run locally, but nothing was deployed.
- **Rate limits and the daily cap** live in memory. They reset on restart and are per instance.
- **Eval size.** 58 questions total, written by one person. Good enough to compare configs on this corpus, too small to quote as a general accuracy figure.
