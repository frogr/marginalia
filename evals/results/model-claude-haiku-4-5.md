# Model path: claude-haiku-4-5 (2026-10-07)

Every question in evals/questions.json and evals/holdout.json, through the real pipeline with `claude-haiku-4-5` writing the answer. BM25 retrieval, 8 passages, one retry allowed. Produced by `npm run eval:model`.

| | |
| --- | --- |
| Questions | 58 (0 fell back to extractive) |
| Model said not found | 19 |
| Quotes verified in the first reply | 62 of 67 (92.5%) |
| Answers clean on the first try (every quote verified, every claim cited) | 36 of 39 (92.3%) |
| Answers that needed the retry | 3, of which the retry fixed everything in 1 |
| Quotes verified in the answer shown | 63 of 67 (94%) |
| Answers shown with an unverified quote | 2 |
| Gold passage retrieved | 35 of 39 |
| ...and a verified quote came from it | 34 of 35 (97.1%) |
| Tokens | 201,859 in, 10,547 out |
| Cost | $0.2546 |
| Latency | p50 1887 ms, p95 5008 ms (retrieve + model + check) |

## By question type

| Type | n | Quotes verified, first reply | Quotes verified, shown | Gold cited when retrieved |
| --- | --- | --- | --- | --- |
| direct | 15 | 95% | 95% | 100% |
| paraphrased | 5 | 76.9% | 76.9% | 66.7% |
| name-free | 11 | 100% | 100% | 100% |
| cross-book | 8 | 92.9% | 100% | 100% |

## Why quotes failed

- 4: not found in the cited passage

The gold-cited number is bounded by retrieval: the model can only quote a gold passage that BM25 put in its eight. Quotes that fail are shown to the visitor as unverified, never dropped, so the "shown" row is what a visitor would see.
