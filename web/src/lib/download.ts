/**
 * Handing a file to the user, having asked them where to put it.
 *
 * The whole of the app's download story, because there was none: nothing in
 * `web/src` created a blob or clicked an anchor, and nothing in `src/` set a
 * `Content-Disposition`. Four call sites want it — three figures and the table.
 *
 * `showSaveFilePicker` rather than a bare anchor, because an export that lands
 * silently in the downloads folder under a name the app chose is a file the user
 * then has to go and find. This is data someone is about to work on: they should
 * say where it goes and what it is called, once, at the moment they ask for it.
 * The picker is also the only way to overwrite the file they exported a minute
 * ago rather than accumulating `flow_cap (3).csv`.
 *
 * It is a Chromium-only API and a secure-context one, so the anchor is still
 * here as the fallback — silently, since a Firefox user has not done anything
 * wrong.
 */

/** The slice of the File System Access API this needs, which TS does not ship. */
interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: Array<{ description: string; accept: Record<string, string[]> }>;
}
type SaveFilePicker = (options: SaveFilePickerOptions) => Promise<{
  createWritable: () => Promise<{
    write: (data: string) => Promise<void>;
    close: () => Promise<void>;
  }>;
}>;

function picker(): SaveFilePicker | null {
  const candidate = (window as unknown as { showSaveFilePicker?: SaveFilePicker })
    .showSaveFilePicker;
  return typeof candidate === "function" ? candidate : null;
}

/**
 * Asks where to save, then writes the file there.
 *
 * Returns false when the user cancelled, so a caller can tell "they changed
 * their mind" from "it was saved" — nothing needs that yet, but a caller that
 * reported success on a cancelled save would be lying.
 *
 * Must be called straight out of a click. The picker needs a live user gesture,
 * and awaiting anything first spends it — which is why every caller builds its
 * CSV synchronously and hands the finished text in.
 */
export async function saveText(
  filename: string,
  text: string,
  mime = "text/csv;charset=utf-8",
): Promise<boolean> {
  const ask = picker();
  if (ask) {
    try {
      const handle = await ask({
        suggestedName: filename,
        types: [
          {
            description: "Comma-separated values",
            accept: { "text/csv": [".csv"] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      return true;
    } catch (caught) {
      // Cancelling is an answer, not a failure: falling back here would save the
      // file the user just declined to save.
      if ((caught as DOMException)?.name === "AbortError") return false;
      // Anything else — a policy block, a context the API refuses — falls
      // through rather than losing the export.
    }
  }

  downloadText(filename, text, mime);
  return true;
}

/** The unconditional download, for a browser with no picker. */
export function downloadText(
  filename: string,
  text: string,
  mime = "text/csv;charset=utf-8",
): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  // Firefox will not follow a click on an element that is not in the document.
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Not synchronously: Safari reads the URL after the click returns, and
  // revoking it first gives a download of zero bytes with no error anywhere.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
