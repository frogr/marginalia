// Marginalia front end. Plain DOM, no build step.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const EXAMPLES = [
  "What words were marked on the little cake Alice found?",
  "At what time had Miss Havisham's clocks stopped?",
  "What does Gatsby say about the green light at the end of Daisy's dock?",
  "What did the Queen use for croquet mallets and balls?",
  "What did Amy burn after quarreling with Jo?",
  "Which Bible story does Sonia read to Raskolnikov?",
];

const SHORT = {
  "alice-in-wonderland": "Alice in Wonderland",
  "the-picture-of-dorian-gray": "Dorian Gray",
  "a-tale-of-two-cities": "Two Cities",
  "crime-and-punishment": "Crime and Punishment",
  "the-great-gatsby": "Gatsby",
  "pride-and-prejudice": "Pride and Prejudice",
};

let books = [];
const selected = new Set();
let last = null;

async function init() {
  const params = new URLSearchParams(location.search);
  (params.get("books") || "").split(",").filter(Boolean).forEach((b) => selected.add(b));
  try {
    const res = await fetch("/api/books");
    books = (await res.json()).books;
  } catch {
    books = [];
  }
  renderChips();
  const list = $(".example-list");
  for (const q of EXAMPLES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip example";
    b.textContent = q;
    b.addEventListener("click", () => {
      $("#q").value = q;
      selected.clear();
      renderChips();
      ask();
    });
    list.append(b);
  }
  $("#ask").addEventListener("submit", (e) => {
    e.preventDefault();
    ask();
  });
  const q = params.get("q");
  if (q) {
    $("#q").value = q;
    ask(false);
  }
}

function renderChips() {
  const wrap = $("#chips");
  wrap.innerHTML = "";
  const all = chip("All twelve", selected.size === 0, () => {
    selected.clear();
    renderChips();
  });
  wrap.append(all);
  for (const b of books) {
    wrap.append(
      chip(SHORT[b.slug] || b.title, selected.has(b.slug), () => {
        selected.has(b.slug) ? selected.delete(b.slug) : selected.add(b.slug);
        if (selected.size === books.length) selected.clear();
        renderChips();
      }, `${b.title}, ${b.author}, ${b.year}`),
    );
  }
}

function chip(label, on, onClick, title) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "chip" + (on ? " on" : "");
  b.setAttribute("aria-pressed", String(on));
  if (title) b.title = title;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

async function ask(push = true) {
  const question = $("#q").value.trim();
  if (question.length < 3) return;
  const status = $("#status");
  const result = $("#result");
  const go = $("#go");
  go.disabled = true;
  status.className = "status muted busy";
  status.textContent = selected.size ? `Searching ${selected.size} book${selected.size > 1 ? "s" : ""}…` : "Searching twelve books…";
  if (push) {
    const p = new URLSearchParams({ q: question });
    if (selected.size) p.set("books", [...selected].join(","));
    history.replaceState(null, "", `?${p}`);
  }
  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question, books: selected.size ? [...selected] : undefined }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    last = data;
    status.className = "status muted";
    status.textContent = "";
    result.innerHTML = renderResult(data);
    result.hidden = false;
    wireResult(result);
    result.scrollIntoView({ block: "start" });
  } catch (e) {
    status.className = "status error";
    status.textContent = e.message;
  } finally {
    go.disabled = false;
  }
}

// ---------- rendering ----------

function passageHtml(text, ranges) {
  // ranges: [{start, end, cls}] in passage offsets. Builds paragraphs with <mark>s.
  const cuts = new Set([0, text.length]);
  for (const r of ranges) {
    cuts.add(r.start);
    cuts.add(r.end);
  }
  const points = [...cuts].sort((a, b) => a - b);
  let html = "<p>";
  for (let i = 0; i + 1 < points.length; i++) {
    const [a, b] = [points[i], points[i + 1]];
    const hit = ranges.find((r) => r.start <= a && r.end >= b);
    const parts = text.slice(a, b).split("\n\n");
    parts.forEach((part, j) => {
      if (j > 0) html += "</p><p>";
      if (!part) return;
      html += hit ? `<mark class="${hit.cls || ""}">${esc(part)}</mark>` : esc(part);
    });
  }
  return html + "</p>";
}

function citeLabel(p) {
  return `${SHORT[p.book] || p.bookTitle} · ${p.chapterTitle.replace(/^.*· /, "")}`;
}

function renderResult(d) {
  const a = d.answer;
  const passages = d.retrieval.passages;
  const allOk = a.total > 0 && a.verified === a.total;
  const badge = a.total
    ? `<span class="pill ${allOk ? "pill--good" : "pill--close"}" title="Quotes found word for word in the passage they cite">Verified quotes ${a.verified}/${a.total}</span>`
    : "";
  const mode =
    a.mode === "model"
      ? `Answered by ${esc(a.model)} from ${passages.length} passages`
      : `Extractive answer: the sentences that best match your question`;

  let body = "";
  if (a.notFound) {
    body = `<p class="none">${
      a.mode === "model"
        ? "The retrieved passages do not answer this question. The closest passages are below."
        : "No sentence in the top passages matches this question well. The closest passages are below."
    }</p>`;
  } else {
    body = a.claims
      .map((c, ci) => {
        const chips = c.citations
          .map((q, qi) => {
            const p = passages[q.n - 1];
            const label = p ? citeLabel(p) : "unknown passage";
            return `<button type="button" class="cite ${q.verified ? "ok" : "bad"}" data-claim="${ci}" data-cite="${qi}" aria-expanded="false">
              <span class="n">${q.n || "?"}</span>${esc(label)}${q.verified ? "" : '<span class="flag">unverified</span>'}</button>`;
          })
          .join("");
        const text = a.mode === "model" ? `<p class="claim-text">${esc(c.text)}</p>` : `<blockquote class="quote">${esc(c.text)}</blockquote>`;
        return `<div class="claim">${text}<div class="cites">${chips}</div><div class="expand" id="x-${ci}" hidden></div></div>`;
      })
      .join("");
  }

  const notice = a.notice ? `<p class="note note--warn">${esc(a.notice)}</p>` : "";
  const regen = a.regenerated
    ? `<p class="note">The first draft had ${a.firstAttempt.total - a.firstAttempt.verified} quote${a.firstAttempt.total - a.firstAttempt.verified === 1 ? "" : "s"} that did not match the text, so the model was asked once to fix ${a.firstAttempt.total - a.firstAttempt.verified === 1 ? "it" : "them"}.</p>`
    : "";

  return `
  <article class="answer panel">
    <div class="answer-head"><span class="mode">${mode}</span>${badge}</div>
    ${notice}${regen}
    <div class="claims">${body}</div>
  </article>
  ${howHtml(d)}`;
}

function howHtml(d) {
  const r = d.retrieval;
  const a = d.answer;
  const named = r.namedBooks.length ? ` Books named in the question got a score boost: ${r.namedBooks.map((b) => SHORT[b] || b).join(", ")}.` : "";
  const filter = d.books.length ? ` Limited to ${d.books.map((b) => SHORT[b] || b).join(", ")}.` : "";
  const method =
    r.method === "hybrid"
      ? "Hybrid search: BM25 keyword ranking and vector similarity, merged with reciprocal rank fusion."
      : "BM25 keyword search with stemming, stopwords, a phrase boost and neighbor-chunk context.";
  const rows = r.passages
    .map(
      (p) => `<tr data-p="${p.n}">
        <td class="num">${p.n}</td>
        <td><button type="button" class="linkish" data-open="${p.n}">${esc(SHORT[p.book] || p.bookTitle)}</button><div class="sub">${esc(p.chapterTitle)}</div></td>
        <td class="num">${p.score}</td>
        <td class="num">${p.bm25Rank ?? "–"}</td>
        ${r.method === "hybrid" ? `<td class="num">${p.vectorRank ?? "–"}</td>` : ""}
      </tr>
      <tr class="ptext" id="pt-${p.n}" hidden><td colspan="${r.method === "hybrid" ? 5 : 4}"><div class="booktext small">${passageHtml(p.text, highlightsFor(d, p))}</div><a class="read" href="${p.readUrl}">Read the whole chapter</a></td></tr>`,
    )
    .join("");
  const checks = a.claims
    .flatMap((c) => c.citations)
    .map(
      (q) => `<li class="${q.verified ? "ok" : "bad"}"><span class="pill ${q.verified ? "pill--good" : "pill--close"}">${q.verified ? "verified" : "unverified"}</span>
        <span class="q">“${esc(q.quote.length > 160 ? q.quote.slice(0, 157) + "…" : q.quote)}”</span>
        <span class="sub">cites passage ${q.n || "?"}${q.verified ? `, found as ${q.pieces.length} exact piece${q.pieces.length > 1 ? "s" : ""}` : `: ${esc(q.reason || "")}${q.foundIn ? ` (it does appear in passage ${q.foundIn})` : ""}`}</span></li>`,
    )
    .join("");
  return `
  <details class="how panel panel--dashed">
    <summary>How this answer was made</summary>
    <ol class="steps">
      <li><h3>Retrieve</h3><p>${method}${filter}${named} ${r.passages.length} passages in ${d.timings.retrieveMs} ms.${r.note ? " " + esc(r.note) : ""}</p>
        <div class="tablewrap"><table class="ptable"><thead><tr><th>#</th><th>Passage</th><th>Score</th><th>BM25 rank</th>${r.method === "hybrid" ? "<th>Vector rank</th>" : ""}</tr></thead><tbody>${rows}</tbody></table></div></li>
      <li><h3>Answer</h3><p>${
        a.mode === "model"
          ? `${esc(a.model)} read the ${r.passages.length} passages and was told to answer only from them, with an exact quote for every claim.${a.regenerated ? " Its first draft had quotes that did not match, so it got one retry with the failures listed." : ""}`
          : "No model is used. Each sentence in the top five passages is scored by how many of the question's rarer words it contains, and the best three distinct sentences are shown."
      } ${d.timings.answerMs} ms.</p></li>
      <li><h3>Check every quote</h3><p>Each quote must appear in the passage it cites, after evening out whitespace, quote marks, dashes and letter case. An ellipsis splits a quote into pieces that must each be found, in order.</p>
        ${checks ? `<ul class="checks">${checks}</ul>` : "<p class=\"sub\">No quotes to check.</p>"}</li>
    </ol>
  </details>`;
}

function highlightsFor(d, p) {
  const ranges = [];
  for (const c of d.answer.claims)
    for (const q of c.citations)
      if (q.passageId === p.id && q.verified) for (const piece of q.pieces) if (piece.found) ranges.push({ start: piece.start, end: piece.end });
  return ranges;
}

function wireResult(root) {
  root.querySelectorAll(".cite").forEach((btn) =>
    btn.addEventListener("click", () => {
      const ci = Number(btn.dataset.claim);
      const qi = Number(btn.dataset.cite);
      const box = $(`#x-${ci}`, root);
      const open = btn.getAttribute("aria-expanded") === "true";
      root.querySelectorAll(`.cite[data-claim="${ci}"]`).forEach((b) => b.setAttribute("aria-expanded", "false"));
      if (open) {
        box.hidden = true;
        return;
      }
      btn.setAttribute("aria-expanded", "true");
      const q = last.answer.claims[ci].citations[qi];
      const p = last.retrieval.passages[q.n - 1];
      if (!p) {
        box.innerHTML = `<p class="warn-text">This citation points to a passage that was not retrieved, so it cannot be checked.</p>`;
        box.hidden = false;
        return;
      }
      const ranges = q.pieces.filter((x) => x.found).map((x) => ({ start: x.start, end: x.end }));
      const warn = q.verified ? "" : `<p class="warn-text">This quote was not found word for word in this passage (${esc(q.reason || "")}). Read the passage and judge for yourself.</p>`;
      box.innerHTML = `${warn}<div class="passage-meta">${esc(p.bookTitle)} · ${esc(p.chapterTitle)} · passage ${p.n}</div>
        <div class="booktext">${passageHtml(p.text, ranges)}</div>
        <a class="read" href="${p.readUrl}">Read the whole chapter</a>`;
      box.hidden = false;
      // Long passages scroll inside the box; bring the first highlight into view.
      const text = $(".booktext", box);
      const mark = $("mark", box);
      if (mark) text.scrollTop = Math.max(0, mark.offsetTop - text.offsetTop - 60);
    }),
  );
  root.querySelectorAll("[data-open]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const row = $(`#pt-${btn.dataset.open}`, root);
      row.hidden = !row.hidden;
    }),
  );
}

init();
