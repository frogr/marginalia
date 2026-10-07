import { serve } from "@hono/node-server";
import { Asker } from "../answer/ask.js";
import { loadConfig } from "../config.js";
import { Library } from "../library.js";
import { createApp } from "./app.js";

const cfg = loadConfig();
const t0 = performance.now();
const lib = Library.fromDir();
const asker = new Asker(lib, cfg);
console.log(
  `loaded ${lib.books.size} books, ${lib.chunks.length} chunks in ${Math.round(performance.now() - t0)} ms; ` +
    `retrieval=${asker.retrievalMethod}, answers=${asker.model ? asker.model.name : "extractive"}, daily model limit=${cfg.dailyLlmLimit}`,
);

const server = serve({ fetch: createApp(asker).fetch, port: cfg.port }, (info) => console.log(`Marginalia on http://localhost:${info.port}`));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}
