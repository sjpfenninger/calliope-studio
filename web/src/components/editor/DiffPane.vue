<script setup lang="ts">
/**
 * Two versions of one file, side by side, in Monaco's diff editor.
 *
 * Separate from `MonacoYamlEditor` and deliberately so: that component owns one
 * long-lived instance holding every open buffer, and is `v-show`n rather than
 * `v-if`d because unmounting it would discard unsaved edits. This has nothing
 * to lose — both texts came from the server and neither is editable — so its
 * models are transient, created per file and disposed on the way out.
 *
 * Three things here are load-bearing:
 *
 * - **The URI scheme is `compare:`, which no schema association matches.**
 *   monaco-yaml keys its `fileMatch` on `file:///…` and `virtual:///*`
 *   (`lib/calliopeSchema.ts`), so a diff model spelled as a file would be
 *   validated — drawing red squiggles over a *historical* version of a file
 *   nobody can edit, against the schema of the Calliope installed today.
 * - **Both sides are forced to LF.** With `core.autocrlf` on, one side can
 *   arrive CRLF and the other LF, and Monaco then paints every line as changed:
 *   a diff claiming the whole file moved, over a difference no editor shows.
 * - **`automaticLayout: false` with a ResizeObserver**, as `MonacoYamlEditor`
 *   does. Monaco's own polling misses the case that matters here, coming back
 *   from `display: none` inside a splitter.
 */
import * as monaco from "monaco-editor";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

import { applyMonacoTheme, MONACO_THEME, monacoFontFamily, monacoFontSize, monacoLineHeight } from "@/editor/monacoTheme";
import { fileKindOf } from "@/lib/fileKind";
import { useUiStore } from "@/stores/ui";

const props = defineProps<{
  /** The *before* text. Empty string when the file was added. */
  original: string;
  /** The *after* text. Empty string when the file was removed. */
  modified: string;
  /** Names the language, and labels the two models. */
  path: string;
}>();

const ui = useUiStore();
const container = ref<HTMLElement | null>(null);

let editor: monaco.editor.IStandaloneDiffEditor | null = null;
let models: monaco.editor.ITextModel[] = [];
let observer: ResizeObserver | null = null;

/**
 * Monaco's own language ids, not this app's file kinds.
 *
 * A CSV is `plaintext` on purpose: Monaco has no CSV grammar, and asking for
 * one it does not have gets no highlighting and no complaint.
 */
function languageOf(path: string): string {
  const kind = fileKindOf(path);
  if (kind === "yaml") return "yaml";
  if (kind === "markdown") return "markdown";
  return "plaintext";
}

function disposeModels() {
  for (const model of models) model.dispose();
  models = [];
}

function build() {
  if (!editor) return;
  disposeModels();

  const language = languageOf(props.path);
  const original = monaco.editor.createModel(
    props.original,
    language,
    monaco.Uri.parse(`compare:///before/${encodeURI(props.path)}`),
  );
  const modified = monaco.editor.createModel(
    props.modified,
    language,
    monaco.Uri.parse(`compare:///after/${encodeURI(props.path)}`),
  );
  original.setEOL(monaco.editor.EndOfLineSequence.LF);
  modified.setEOL(monaco.editor.EndOfLineSequence.LF);
  models = [original, modified];

  editor.setModel({ original, modified });
}

onMounted(() => {
  if (!container.value) return;
  // Before `createDiffEditor`, so it never paints in the stock theme first.
  applyMonacoTheme(ui.mode);
  editor = monaco.editor.createDiffEditor(container.value, {
    theme: MONACO_THEME,
    fontFamily: monacoFontFamily(),
    fontSize: monacoFontSize(),
    lineHeight: monacoLineHeight(),
    readOnly: true,
    originalEditable: false,
    renderSideBySide: true,
    renderOverviewRuler: false,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout: false,
    lineNumbers: "on",
  });
  build();

  observer = new ResizeObserver(() => editor?.layout());
  observer.observe(container.value);
});

watch(() => [props.original, props.modified, props.path], build);

// Redefined and re-set globally, as the editor does: a diff editor created
// later inherits it, and re-creating this one would be a flash of stock colours.
watch(
  () => ui.revision,
  () => applyMonacoTheme(ui.mode),
);

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
  editor?.dispose();
  editor = null;
  // After the editor, which still references them until it is gone.
  disposeModels();
});
</script>

<template>
  <div ref="container" class="absolute inset-0" data-testid="diff-pane" />
</template>
