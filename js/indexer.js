// Keeps the IndexedDB "tours" store in sync with the folder:
// new files parsed, changed files re-parsed, deleted files removed.
// Parsing runs in a Web Worker when possible, otherwise inline (both use analyzer.js).

import { getAllTours, putTours, deleteTours } from "./db.js";
import { iterateGpxFiles, supportsObserver } from "./folderAccess.js";
import { makeSignature, ANALYZER_VERSION } from "./analyzer.js";

// --- parser: worker with inline fallback -------------------------------------

let workerApi = null;

function getParser() {
  if (workerApi) return workerApi;

  let worker = null;
  try {
    worker = new Worker(new URL("./parseWorker.js", import.meta.url), {
      type: "module",
    });
  } catch {
    worker = null;
  }

  if (worker) {
    const pending = new Map();
    let seq = 0;
    worker.onmessage = (e) => {
      const { id, draft, error } = e.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      error ? p.reject(new Error(error)) : p.resolve(draft);
    };
    worker.onerror = () => {
      for (const p of pending.values()) p.reject(new Error("Worker-Fehler"));
      pending.clear();
    };
    workerApi = {
      analyze(text, file) {
        const id = ++seq;
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          worker.postMessage({ id, text, file });
        });
      },
    };
  } else {
    const mod = import("./analyzer.js");
    workerApi = {
      async analyze(text, file) {
        const { analyzeGpx } = await mod;
        return analyzeGpx(text, file);
      },
    };
  }
  return workerApi;
}

// --- scan ------------------------------------------------------------------

// macOS / iCLoud hand filenames back in different Unicode normal forms at
// different times (NFC vs NFD – umlauts especially). Compare on NFC so the same
// file isn't seen as "one gone, one new" and its record wiped + re-added blank.
export const nfc = (s) => (typeof s === "string" ? s.normalize("NFC") : s);

/**
 * Carry every user edit and already-resolved geocoding result from the stored
 * record onto a freshly parsed draft. Starts from `{...current, ...draft}` so
 * that any field only present on the old record (a legacy or future one) also
 * survives, then pins the values the user / geocoder own.
 */
export function mergePreserving(current, draft) {
  const merged = { ...current, ...draft };
  merged.categoryUser =
    current.categoryUser === "planning" ? null : current.categoryUser ?? null;
  merged.isPlanUser =
    current.isPlanUser === true || current.isPlanUser === false
      ? current.isPlanUser
      : current.categoryUser === "planning"
      ? true
      : null;
  merged.titleUser = current.titleUser || null;
  merged.titleAuto = current.titleAuto || null;
  // rating replaces the old boolean "isFavorite" (migrate: favorite -> 5)
  merged.rating = current.rating != null ? current.rating : current.isFavorite ? 5 : 0;
  merged.hidden = !!current.hidden;
  merged.notes = current.notes || "";
  merged.placeNames = current.placeNames || [];
  merged.placesRanked = current.placesRanked || [];
  merged.region = current.region || "";
  merged.nearPlace = current.nearPlace || "";
  merged.country = current.country || "";
  merged.countryCode = current.countryCode || "";
  merged.placesResolved = !!current.placesResolved;
  merged.geoV = current.geoV || 0;
  // keep a previously geocoded summit name if this re-parse found none in a <wpt>
  if (!draft.summitName && draft.isSummitTour) {
    merged.summitName = current.summitName || null;
    merged.summitEle = draft.summitEle || current.summitEle || null;
  }
  return merged;
}

/**
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {{onProgress?:(done:number,total:number)=>void,
 *          onError?:(fileName:string,message:string)=>void}} [opts]
 * @returns {Promise<{added:number,updated:number,removed:number,failed:number,skipped:number}>}
 */
export async function scan(dirHandle, opts = {}) {
  const { onProgress, onError } = opts;
  const parser = getParser();

  const existing = await getAllTours();
  const byName = new Map(existing.map((t) => [nfc(t.fileName), t]));

  const files = [];
  let listingComplete = true;
  try {
    for await (const entry of iterateGpxFiles(dirHandle)) files.push(entry);
  } catch (err) {
    // iCloud can error out mid-listing; treat what we have as a partial view.
    listingComplete = false;
    onError?.("(Ordnerliste)", String(err && err.message ? err.message : err));
  }

  const present = new Set(files.map((f) => nfc(f.name)));
  const removedNames = existing
    .map((t) => t.fileName)
    .filter((name) => !present.has(nfc(name)));

  const total = files.length;
  let done = 0;
  let matched = 0; // existing records we recognised this scan (skipped or updated)
  const stats = { added: 0, updated: 0, removed: 0, failed: 0, skipped: 0 };
  const toWrite = [];
  const staleKeys = []; // old records whose stored fileName was a different Unicode form

  for (const entry of files) {
    done++;
    onProgress?.(done, total);

    let file;
    try {
      file = await entry.getFile();
    } catch (err) {
      stats.failed++;
      onError?.(entry.name, String(err));
      continue;
    }

    const name = nfc(entry.name); // the one canonical key we ever store under
    const signature = makeSignature(file.size, file.lastModified);
    const current = byName.get(name);
    const reKey = current && current.fileName !== name; // stored under an NFD spelling

    if (current && current.av === ANALYZER_VERSION) {
      if (current.signature === signature && !reKey) {
        matched++;
        stats.skipped++;
        continue;
      }
      // Same size + analyzer version: the content is unchanged, only the mtime
      // moved (iCloud re-materialising a placeholder file bumps it). Refresh the
      // stored signature, keep every parsed value and user edit, don't re-parse.
      if (current.size === file.size) {
        matched++;
        stats.skipped++;
        toWrite.push({ ...current, fileName: name, signature, lastModified: file.lastModified });
        if (reKey) staleKeys.push(current.fileName);
        if (toWrite.length >= 40) await putTours(toWrite.splice(0));
        continue;
      }
    }

    let draft;
    try {
      const text = await file.text();
      draft = await parser.analyze(text, {
        fileName: name,
        size: file.size,
        lastModified: file.lastModified,
      });
    } catch (err) {
      stats.failed++;
      onError?.(entry.name, String(err && err.message ? err.message : err));
      continue;
    }

    if (current) {
      matched++;
      const merged = mergePreserving(current, draft);
      merged.fileName = name;
      toWrite.push(merged);
      if (reKey) staleKeys.push(current.fileName);
      stats.updated++;
    } else {
      toWrite.push(draft);
      stats.added++;
    }

    if (toWrite.length >= 40) {
      await putTours(toWrite.splice(0));
    }
  }

  await putTours(toWrite);

  // Records we just rewrote under the canonical (NFC) key – drop the old
  // duplicate. These are confirmed re-keys, safe regardless of the guard below.
  if (staleKeys.length) await deleteTours(staleKeys);

  // Only act on removals when this scan actually recognised the folder. A
  // still-syncing iCloud directory can list nothing or a stale subset, and a
  // filename-normalisation shift makes every file look new while every record
  // looks gone – deleting then would wipe places, hidden flags and plan markers
  // and re-add the tours blank on the next start.
  const trustworthy =
    listingComplete && files.length > 0 && (existing.length === 0 || matched > 0);

  if (trustworthy && removedNames.length) {
    await deleteTours(removedNames);
    stats.removed = removedNames.length;
  } else if (removedNames.length) {
    onError?.(
      "(Ordner unvollständig gelesen)",
      `${removedNames.length} Tour(en) nicht gefunden – Löschen übersprungen`
    );
  }

  return stats;
}

// --- change watching -----------------------------------------------------

/**
 * Watch the folder for changes. Returns a disposer, or null if the
 * FileSystemObserver API is unavailable (caller then falls back to focus rescan).
 */
export function watchFolder(dirHandle, onChange) {
  if (!supportsObserver()) return null;
  try {
    // eslint-disable-next-line no-undef
    const observer = new FileSystemObserver(() => onChange());
    observer.observe(dirHandle, { recursive: false });
    return () => observer.disconnect();
  } catch {
    return null;
  }
}
