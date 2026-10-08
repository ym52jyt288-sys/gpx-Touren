// Module worker: parse + analyze one GPX file off the main thread.
// Falls back gracefully — if the worker cannot be created (e.g. file:// origin),
// indexer.js imports analyzer.js directly instead.

import { analyzeGpx } from "./analyzer.js";

self.onmessage = (e) => {
  const { id, text, file } = e.data;
  try {
    const draft = analyzeGpx(text, file);
    self.postMessage({ id, draft });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message ? err.message : err) });
  }
};
