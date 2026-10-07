// Server-rendered chapter pages, so every citation can link to its full
// surrounding chapter. ?from=&to= (1-based paragraph numbers) highlights the
// cited passage.
import type { Library } from "../library.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function renderChapter(lib: Library, slug: string, chapterNo: number, from?: number, to?: number): string | undefined {
  const book = lib.books.get(slug);
  const ch = book?.chapters[chapterNo - 1];
  if (!book || !ch) return undefined;
  const lo = from ?? 0;
  const hi = to ?? from ?? 0;
  const paras = ch.paragraphs
    .map((p, i) => {
      const n = i + 1;
      const mark = n >= lo && n <= hi ? ' class="cited"' : "";
      return `<p id="p${n}"${mark}><a class="pn" href="#p${n}" aria-label="Paragraph ${n}">${n}</a>${esc(p.text)}</p>`;
    })
    .join("\n");
  const prev = chapterNo > 1 ? `<a href="/read/${slug}/${chapterNo - 1}">Previous chapter</a>` : "<span></span>";
  const next = chapterNo < book.chapters.length ? `<a href="/read/${slug}/${chapterNo + 1}">Next chapter</a>` : "<span></span>";
  const translator = book.translator ? `, translated by ${esc(book.translator)}` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(ch.title)} · ${esc(book.title)} · Marginalia</title>
<link rel="icon" href="/favicon.svg">
<link rel="stylesheet" href="/styles.css">
</head>
<body class="reader">
<header class="top">
  <a class="mark" href="/">Marginalia</a>
  <span class="crumb">${esc(book.title)}</span>
</header>
<main class="chapter">
  <p class="eyebrow">${esc(book.title)} · ${esc(book.author)}${translator} · ${book.year}</p>
  <h1>${esc(ch.title)}</h1>
  <nav class="chapnav">${prev}${next}</nav>
  <article class="booktext">
${paras}
  </article>
  <nav class="chapnav">${prev}${next}</nav>
  <p class="source">Text from <a href="${esc(book.sourceUrl)}">Project Gutenberg</a> (public domain in the US). Paragraph numbers are Marginalia's.</p>
</main>
</body>
</html>`;
}
