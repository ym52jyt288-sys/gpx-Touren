import { el, clear } from "../dom.js";
import { supportsFileSystemAccess, supportsDirectoryInput } from "../folderAccess.js";

/**
 * @param {HTMLElement} mount
 * @param {{mode:"pick"|"reconnect"|"import", folderName?:string, onPick:(opts?:object)=>void, error?:string}} o
 */
export function renderFolderSetup(mount, o) {
  clear(mount);
  if (o.mode === "import") return renderImportSetup(mount, o);

  const supported = supportsFileSystemAccess();
  const isReconnect = o.mode === "reconnect";

  const card = el(
    "div",
    { class: "setup-card" },
    el("div", { class: "setup-icon", text: "📁" }),
    el("h1", { text: isReconnect ? "Ordner erneut freigeben" : "GPX-Ordner wählen" }),
    el("p", {
      class: "muted",
      text: isReconnect
        ? `Zugriff auf „${o.folderName || "den Ordner"}“ muss nach dem Neuladen einmal bestätigt werden.`
        : "Wähle den Ordner mit deinen aus APE@MAP exportierten GPX-Dateien – in der Regel den iCloud-Drive-Ordner „GPX-Touren“.",
    })
  );

  if (!supported) {
    card.append(
      el("p", {
        class: "warn",
        html:
          "Dieser Browser unterstützt die <strong>File System Access API</strong> nicht. " +
          "Bitte <strong>Google Chrome</strong> oder <strong>Microsoft Edge</strong> verwenden. " +
          "Alternativ unten einen Ordner ohne dauerhaften Zugriff wählen (muss pro Sitzung neu gewählt werden).",
      })
    );
  }

  const btn = el("button", {
    class: "btn primary big",
    text: isReconnect ? "Freigeben & laden" : "Ordner auswählen",
    onclick: () => o.onPick(),
  });
  card.append(btn);

  if (o.error) card.append(el("p", { class: "error", text: o.error }));

  card.append(el("p", { class: "muted small", html: folderPathHint() }));

  mount.append(el("div", { class: "setup-wrap" }, card));
}

/** OS-specific hint for reaching the iCloud-Drive folder in the picker. */
function folderPathHint() {
  const ua = navigator.userAgent || "";
  if (/Windows/i.test(ua)) {
    return (
      "Tipp: Im Auswahldialog den Pfad oben ins Adressfeld eingeben – iCloud Drive " +
      "liegt meist unter <code>C:\\Users\\&lt;Name&gt;\\iCloudDrive</code> " +
      "(iCloud für Windows vorausgesetzt)."
    );
  }
  if (/Mac OS X|Macintosh/i.test(ua)) {
    return (
      "Tipp: Im Auswahldialog <kbd>⌘⇧G</kbd> drücken und " +
      "<code>~/Library/Mobile Documents/com~apple~CloudDocs</code> einfügen."
    );
  }
  return "Tipp: Den Ordner mit deinen GPX-Dateien auswählen (z. B. den iCloud-Drive-Ordner).";
}

const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

const isStandalone = () =>
  window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;

/** No persistent folder access (iPhone/Safari): the files are imported as copies. */
function renderImportSetup(mount, o) {
  const card = el(
    "div",
    { class: "setup-card" },
    o.mobile
      ? el("img", { class: "msetup-icon", src: "icons/icon.svg", alt: "" })
      : el("div", { class: "setup-icon", text: "📥" }),
    el("h1", { text: o.mobile ? "Deine Touren" : "GPX-Dateien importieren" }),
    el("p", {
      class: "muted",
      text:
        "Wähle die aus APE@MAP exportierten GPX-Dateien aus. Die App legt eine eigene " +
        "Kopie an und arbeitet danach auch offline. Neue Exporte holst du später über " +
        "„＋ Importieren“ dazu, bereits importierte Dateien werden übersprungen.",
    })
  );

  card.append(
    el("button", {
      class: "btn primary big",
      text: o.mobile ? "GPX-Dateien importieren" : "Dateien auswählen",
      onclick: () => o.onPick({ directory: false }),
    })
  );
  if (supportsDirectoryInput()) {
    card.append(
      el("button", {
        class: "btn big",
        style: "margin-left:8px",
        text: "Ganzen Ordner wählen",
        onclick: () => o.onPick({ directory: true }),
      })
    );
  }

  if (o.error) card.append(el("p", { class: "error", text: o.error }));

  if (isIOS()) {
    card.append(
      el("p", {
        class: "muted small",
        html:
          "Tipp: Im Auswahlfenster <strong>Durchsuchen → iCloud Drive</strong> → deinen " +
          "GPX-Ordner öffnen, oben rechts <strong>Auswählen</strong> → unten " +
          "<strong>Alle auswählen</strong> → <strong>Öffnen</strong>.",
      })
    );
    if (!isStandalone()) {
      card.append(
        el("p", {
          class: "warn",
          html:
            "Für dauerhafte Speicherung die App zuerst installieren: in Safari " +
            "<strong>Teilen → Zum Home-Bildschirm</strong> und von dort starten. " +
            "Erst dort importieren: Safari-Tab und Home-Bildschirm-App haben getrennte Speicher, " +
            "und in einem Safari-Tab kann iOS die Daten nach einigen Tagen ohne Nutzung löschen.",
        })
      );
    }
  }

  mount.append(el("div", { class: "setup-wrap" }, card));
}
