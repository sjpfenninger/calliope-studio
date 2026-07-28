/**
 * Handing a file to the browser.
 *
 * The whole of the app's download story, because there was none: nothing in
 * `web/src` created a blob or clicked an anchor, and nothing in `src/` set a
 * `Content-Disposition`. Four call sites want it now — three figures and the
 * table — so it is a function rather than four copies of the same six lines.
 */

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
