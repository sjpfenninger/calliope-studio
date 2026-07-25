/**
 * Monaco + monaco-yaml setup.
 *
 * Worker registration happens at module load (must run before any editor is created).
 * Call initMonacoYaml() once from EditorView.vue onMounted to fetch the Calliope
 * schema and configure monaco-yaml with it.
 */
import * as monaco from "monaco-editor";
import { configureMonacoYaml, type SchemasSettings } from "monaco-yaml";

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
      const schema = await res.json();
      schemas = [
        {
          uri: "https://calliope.readthedocs.io/schema",
          fileMatch: ["*.yaml", "*.yml"],
          schema,
        },
      ];
    }
  } catch {
    // Monaco works fine without a schema — just no autocompletion.
  }
  configureMonacoYaml(monaco, { enableSchemaRequest: false, schemas });
}
