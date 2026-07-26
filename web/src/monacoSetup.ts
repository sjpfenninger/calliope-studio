/**
 * Monaco + monaco-yaml setup.
 *
 * Worker registration happens at module load, which must run before any editor
 * is created. `initMonacoYaml()` is called once by the shell to fetch Calliope's
 * schema and hand it to monaco-yaml.
 *
 * **monaco-editor is pinned to 0.52.x on purpose.** 0.53 changed how a worker
 * hands its foreign module to the main thread, and monaco-yaml still speaks the
 * older protocol: under 0.55 its language worker answered nothing at all —
 * `Missing requestHandler or method: doValidation / findLinks / getCodeAction /
 * findDocumentSymbols / getFoldingRanges` — so validation, completion, symbols
 * and folding were dead, with six console errors as the only sign. Lift the pin
 * only when monaco-yaml supports the newer protocol, and let
 * `npm run monaco-check` decide whether it does.
 */
import * as monaco from "monaco-editor";
import { configureMonacoYaml, type SchemasSettings } from "monaco-yaml";

import { withSiblingSchemas } from "./lib/calliopeSchema";

// Vite handles ?worker imports as separate web worker bundles.
// @ts-ignore
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
// @ts-ignore
import YamlWorker from "monaco-yaml/yaml.worker?worker";

(self as any).MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    if (label === "yaml") return new YamlWorker();
    return new EditorWorker();
  },
};

export async function initMonacoYaml(): Promise<void> {
  let schemas: SchemasSettings[] = [];
  try {
    const res = await fetch("/api/schema/calliope/");
    if (res.ok) {
      schemas = [
        {
          uri: "https://calliope.readthedocs.io/schema",
          fileMatch: ["*.yaml", "*.yml"],
          // With `config:` folded in, or the block a user edits most often has
          // no completion and validates as an unknown key.
          schema: withSiblingSchemas(await res.json()),
        },
      ];
    }
  } catch {
    // Monaco works fine without a schema — just no autocompletion.
  }
  configureMonacoYaml(monaco, { enableSchemaRequest: false, schemas });
}
