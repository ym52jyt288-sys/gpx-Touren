// In-memory stand-in for js/db.js (Node has no IndexedDB). Only what
// localFolder.js + indexer.scan() need. Swapped in by test/localFolder.test.mjs.
const tours = new Map();
const files = new Map();

export const _reset = () => { tours.clear(); files.clear(); };

export async function getAllTours() { return [...tours.values()].map((t) => ({ ...t })); }
export async function putTours(list) { for (const t of list) tours.set(t.fileName, { ...t }); }
export async function deleteTours(names) { for (const n of names) tours.delete(n); }

export async function getFileRec(name) { return files.get(name); }
export async function listFileRecs() { return [...files.values()]; }
export async function countFiles() { return files.size; }
export async function putFiles(recs) { for (const r of recs) files.set(r.name, r); }
export async function deleteFiles(names) { for (const n of names) files.delete(n); }
export async function clearFiles() { files.clear(); }

const meta = new Map();
export async function getMeta(k) { return meta.get(k); }
export async function setMeta(k, v) { meta.set(k, v); }
export async function deleteMeta(k) { meta.delete(k); }
