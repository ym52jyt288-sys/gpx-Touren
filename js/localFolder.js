// Local GPX library for browsers without a persistent folder handle (iPhone/iPad
// Safari, Firefox): imported files are copied into the IndexedDB "files" store and
// exposed through a tiny object that mimics the parts of FileSystemDirectoryHandle
// the app uses (values(), getFileHandle(), entry.getFile()). indexer.scan() and the
// detail view therefore work unchanged on top of it.

import { listFileRecs, getFileRec, putFiles, deleteFiles, clearFiles, countFiles } from "./db.js";

export const LOCAL_LIBRARY_NAME = "Lokale Bibliothek";

const nfc = (s) => (typeof s === "string" ? s.normalize("NFC") : s);

function fileFromRec(rec) {
  return new File([rec.blob], rec.name, {
    type: "application/gpx+xml",
    lastModified: rec.lastModified,
  });
}

function entryFromRec(rec) {
  return { kind: "file", name: rec.name, getFile: async () => fileFromRec(rec) };
}

/** Directory-handle look-alike backed by the "files" store. */
export function createLocalFolderHandle() {
  return {
    kind: "directory",
    name: LOCAL_LIBRARY_NAME,
    isLocalLibrary: true,
    async *values() {
      for (const rec of await listFileRecs()) yield entryFromRec(rec);
    },
    async getFileHandle(name) {
      const rec = (await getFileRec(nfc(name))) || (await getFileRec(name));
      if (!rec) throw new DOMException(`${name} nicht gefunden`, "NotFoundError");
      return entryFromRec(rec);
    },
  };
}

export async function localFileCount() {
  try {
    return await countFiles();
  } catch {
    return 0;
  }
}

/**
 * Copy picked files into the library. Additive: files not picked again stay.
 * A file with the same name + size + mtime is skipped; same name but different
 * content replaces the stored copy (scan() then re-parses it, keeping user edits).
 * @param {Iterable<File>} fileList
 * @returns {Promise<{added:number, replaced:number, skipped:number, ignored:number}>}
 */
export async function importFiles(fileList) {
  const existing = new Map((await listFileRecs()).map((r) => [r.name, r]));
  const stats = { added: 0, replaced: 0, skipped: 0, ignored: 0 };
  let batch = [];
  for (const file of fileList) {
    if (!/\.gpx$/i.test(file.name)) {
      stats.ignored++;
      continue;
    }
    const name = nfc(file.name);
    const prev = existing.get(name);
    if (prev && prev.size === file.size && prev.lastModified === file.lastModified) {
      stats.skipped++;
      continue;
    }
    // Read into memory now: a File from <input> can become unreadable once the
    // picker's temporary copy (iOS) is gone.
    const blob = new Blob([await file.arrayBuffer()], { type: "application/gpx+xml" });
    batch.push({ name, size: file.size, lastModified: file.lastModified || Date.now(), blob });
    if (prev) stats.replaced++;
    else stats.added++;
    if (batch.length >= 40) {
      await putFiles(batch);
      batch = [];
    }
  }
  await putFiles(batch);
  return stats;
}

export async function removeLocalFiles(names) {
  await deleteFiles(names.map(nfc));
}

export async function clearLocalLibrary() {
  await clearFiles();
}
