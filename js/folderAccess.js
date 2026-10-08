// Folder selection + persistence via the File System Access API.
// The chosen directory handle is stored in IndexedDB so the same folder is
// reused across reloads (the browser asks for permission again with one click).

import { getMeta, setMeta, deleteMeta } from "./db.js";

const HANDLE_KEY = "dirHandle";

export function supportsFileSystemAccess() {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

export function supportsObserver() {
  return typeof window !== "undefined" && "FileSystemObserver" in window;
}

/** Show the OS folder picker and remember the choice. Must run from a user gesture. */
export async function pickFolder() {
  const handle = await window.showDirectoryPicker({
    id: "gpx-touren",
    mode: "read",
    startIn: "documents",
  });
  await setMeta(HANDLE_KEY, handle);
  return handle;
}

/** @returns {Promise<{handle: FileSystemDirectoryHandle, permission: PermissionState}|null>} */
export async function restoreFolder() {
  const handle = await getMeta(HANDLE_KEY);
  if (!handle) return null;
  let permission = "prompt";
  try {
    permission = await handle.queryPermission({ mode: "read" });
  } catch {
    // handle no longer valid
    return null;
  }
  return { handle, permission };
}

/** Re-request read permission. Must run from a user gesture. */
export async function ensurePermission(handle) {
  if ((await handle.queryPermission({ mode: "read" })) === "granted") return true;
  return (await handle.requestPermission({ mode: "read" })) === "granted";
}

export async function forgetFolder() {
  await deleteMeta(HANDLE_KEY);
}

/** Async-iterate the *.gpx files in a directory handle. */
export async function* iterateGpxFiles(dirHandle) {
  for await (const entry of dirHandle.values()) {
    if (entry.kind === "file" && /\.gpx$/i.test(entry.name)) {
      yield entry;
    }
  }
}

// --- local library mode (iPhone/iPad Safari, Firefox) -----------------------

/**
 * True when the app keeps its own copy of the GPX files instead of reading a
 * folder handle. `?local` in the URL forces it (handy for testing on desktop).
 */
export function useLocalLibrary() {
  if (typeof window === "undefined") return false;
  try {
    if (new URLSearchParams(location.search).has("local")) return true;
  } catch {
    /* noop */
  }
  return !supportsFileSystemAccess();
}

/** Whether <input type=file> can pick a whole folder here (iOS support varies). */
export function supportsDirectoryInput() {
  if (typeof document === "undefined") return false;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return !isIOS && "webkitdirectory" in document.createElement("input");
}

/**
 * Open the system file picker for GPX files. Must run synchronously inside a
 * user gesture (no await before calling). Resolves with the picked File[]
 * (empty when cancelled). No `accept` filter on purpose: iOS greys out .gpx
 * files it has no type mapping for – the caller filters by extension.
 */
export function pickGpxFiles({ directory = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    if (directory) input.webkitdirectory = true;
    input.style.display = "none";
    let settled = false;
    const done = (files) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => done(Array.from(input.files || [])));
    input.addEventListener("cancel", () => done([]));
    document.body.append(input);
    input.click();
  });
}
