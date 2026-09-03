/**
 * Reading the *unsaved* text of a file tab.
 *
 * The markdown preview has to render the buffer, not the file: editing in
 * Source and switching back to Preview must show what was just typed, and a
 * fetch would show what was last saved. Monaco's model registry is that buffer —
 * it is global and keyed by URI, so nothing needs to be threaded through a store
 * to reach it.
 *
 * It exists as a module chiefly so `fileModelUri` is written once. The URI
 * scheme is a private arrangement between the editor and this file, and a
 * preview that guessed it wrong would silently fall back to the fetched text —
 * the failure would look like the toggle not working, with nothing logged.
 */
import * as monaco from "monaco-editor";

import { fileUri } from "./calliopeSchema";

/**
 * Where `MonacoYamlEditor` puts the model for a real file on disk.
 *
 * The string comes from `calliopeSchema` because that is where the same
 * spelling is used to build monaco-yaml's `fileMatch` lists, and a file whose
 * two spellings differ gets no schema at all with nothing logged.
 */
export function fileModelUri(path: string): monaco.Uri {
  return monaco.Uri.parse(fileUri(path));
}

/**
 * The buffer's current text, or null if no editor has opened this file yet.
 *
 * Null rather than `""` on purpose: the caller has to be able to tell "not
 * loaded" from "loaded and empty", and an empty README is a real thing.
 */
export function bufferText(path: string): string | null {
  return monaco.editor.getModel(fileModelUri(path))?.getValue() ?? null;
}

/**
 * Calls back on every edit to this file's buffer, until the returned function
 * is called. A no-op unsubscribe when there is no model to watch.
 */
export function onBufferChange(path: string, listener: () => void): () => void {
  const model = monaco.editor.getModel(fileModelUri(path));
  if (!model) return () => {};
  const disposable = model.onDidChangeContent(listener);
  return () => disposable.dispose();
}
