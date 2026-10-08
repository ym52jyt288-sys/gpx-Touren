// Local library (iPhone mode) end to end without a browser:
//   node test/localFolder.test.mjs
// js/db.js is redirected to the in-memory test/fakeDb.mjs via a module hook.

import { register } from "node:module";
import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const fake = pathToFileURL(join(here, "fakeDb.mjs")).href;
register(
  "data:text/javascript," +
    encodeURIComponent(`
      export async function resolve(spec, ctx, next) {
        if (spec === "./db.js" || spec === "../db.js") return { url: ${JSON.stringify(fake)}, shortCircuit: true };
        return next(spec, ctx);
      }`)
);

const db = await import(fake);
const lf = await import("../js/localFolder.js");
const { scan } = await import("../js/indexer.js");

const sampleDir = join(here, "..", "SampleData");
async function sampleFiles() {
  const out = [];
  for (const name of (await readdir(sampleDir)).filter((n) => /\.gpx$/i.test(n))) {
    const p = join(sampleDir, name);
    out.push(new File([await readFile(p)], name, { lastModified: (await stat(p)).mtimeMs | 0 }));
  }
  return out;
}

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log("  ✓", name);
  } catch (err) {
    failures++;
    console.log("  ✗", name, "\n   ", err.message);
  }
}

const files = await sampleFiles();
const N = files.length;
const handle = lf.createLocalFolderHandle();

await check(`import of ${N} files + scan indexes all of them`, async () => {
  const st = await lf.importFiles([...files, new File(["x"], "notes.txt")]);
  assert.equal(st.added, N);
  assert.equal(st.ignored, 1);
  const s = await scan(handle);
  assert.equal(s.added, N);
  assert.equal((await db.getAllTours()).length, N);
});

await check("re-importing the same files skips them; rescan changes nothing", async () => {
  const st = await lf.importFiles(files);
  assert.equal(st.skipped, N);
  assert.equal(st.added + st.replaced, 0);
  const s = await scan(handle);
  assert.equal(s.skipped, N);
  assert.equal(s.added + s.updated + s.removed, 0);
});

await check("importing a subset never removes the others (additive)", async () => {
  await lf.importFiles(files.slice(0, 1));
  await scan(handle);
  assert.equal((await db.getAllTours()).length, N);
});

await check("getFileHandle reads back the original text (detail view)", async () => {
  const fh = await handle.getFileHandle(files[0].name);
  const f = await fh.getFile();
  assert.equal(await f.text(), await files[0].text());
});

await check("changed content replaces the copy and keeps user edits", async () => {
  const name = files[0].name;
  const tours = await db.getAllTours();
  const t = tours.find((x) => x.fileName === name.normalize("NFC"));
  await db.putTours([{ ...t, rating: 4, notes: "schön" }]);
  const text = (await files[0].text()).replace("</gpx>", "<!-- edit --></gpx>");
  const st = await lf.importFiles([new File([text], name, { lastModified: Date.now() })]);
  assert.equal(st.replaced, 1);
  const s = await scan(handle);
  assert.equal(s.updated, 1);
  const after = (await db.getAllTours()).find((x) => x.fileName === t.fileName);
  assert.equal(after.rating, 4);
  assert.equal(after.notes, "schön");
});

await check("NFD file name is stored under its NFC key", async () => {
  const nfd = "Ötztal-Runde.gpx".normalize("NFD");
  await lf.importFiles([new File([await files[1].text()], nfd)]);
  assert.ok(await db.getFileRec("Ötztal-Runde.gpx".normalize("NFC")));
  const fh = await handle.getFileHandle(nfd);
  assert.ok(await (await fh.getFile()).text());
  await scan(handle);
  assert.equal((await db.getAllTours()).length, N + 1);
});

await check("explicit delete removes copy + tour on the next scan path", async () => {
  const name = "Ötztal-Runde.gpx";
  await lf.removeLocalFiles([name.normalize("NFD")]);
  await db.deleteTours([name.normalize("NFC")]);
  const s = await scan(handle);
  assert.equal(s.removed, 0);
  assert.equal((await db.getAllTours()).length, N);
  await assert.rejects(handle.getFileHandle(name));
});

await check("clearing the library leaves nothing to scan", async () => {
  await lf.clearLocalLibrary();
  assert.equal(await lf.localFileCount(), 0);
});

console.log(failures ? `\n${failures} Fehler.` : "\nAlles OK.");
process.exit(failures ? 1 : 0);
