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
import { configureMonacoYaml, type MonacoYaml, type SchemasSettings } from "monaco-yaml";

import {
  schemaEntries,
  type CalliopeSchema,
  type FileKind,
} from "./lib/calliopeSchema";

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

/**
 * The live monaco-yaml configuration, kept so that it can be reconfigured.
 *
 * Which schema applies to which file is not knowable at startup: it depends on
 * the model that is open, on its `import:` graph, and on any correction the user
 * has made. `update` is monaco-yaml's own supported way of restating the
 * associations, and re-calling `configureMonacoYaml` would leave two.
 */
let configured: MonacoYaml | null = null;

/** The schema payload, held so an assignment change need not refetch it. */
let payload: CalliopeSchema | null = null;

/**
 * The latest assignment, which may arrive before the payload does.
 *
 * A model's file kinds are fetched in parallel with the schema itself, and
 * either can win. Recording the assignment rather than dropping it means the
 * race has one outcome instead of two.
 */
let assignment: {
  detected: Record<string, FileKind | string>;
  overrides: Record<string, FileKind>;
} = { detected: {}, overrides: {} };

export async function initMonacoYaml(): Promise<void> {
  ignoreMonacoCancellations();
  try {
    const res = await fetch("/api/schema/calliope/");
    if (res.ok) payload = await res.json();
  } catch {
    // Monaco works fine without a schema — just no autocompletion.
  }
  configured = configureMonacoYaml(monaco, {
    enableSchemaRequest: false,
    schemas: currentSchemas(),
  });
}

/**
 * Points each schema at the files it describes.
 *
 * Called whenever the workspace's detected kinds change or the user overrides
 * one. Safe before `initMonacoYaml` has resolved — the assignment is recorded
 * and picked up when it is.
 */
export async function setSchemaAssignments(
  detected: Record<string, FileKind | string>,
  overrides: Record<string, FileKind> = {},
): Promise<void> {
  assignment = { detected, overrides };
  if (!configured) return;

  // Only when the associations really differ. The store watches two reactive
  // objects deeply, so it fires on changes that resolve to the same matches, and
  // every `update` tears down the diagnostics adapter and revalidates every open
  // model for nothing.
  const schemas = currentSchemas();
  const next = JSON.stringify(schemas);
  if (next === applied) return;
  applied = next;

  await configured.update({ enableSchemaRequest: false, schemas });
}

/**
 * Monaco's cancellation, by exactly the test monaco itself uses.
 *
 * `base/common/errors.ts` builds these with `name` and `message` both set to the
 * literal `Canceled`, and `isCancellationError` checks both. Copied rather than
 * imported: it lives behind a deep path into monaco's internals, and this repo
 * pins monaco for a reason — a two-field comparison is a cheaper thing to own
 * than an import that a patch release can move.
 */
function isMonacoCancellation(error: unknown): boolean {
  return (
    error instanceof Error && error.name === "Canceled" && error.message === "Canceled"
  );
}

/**
 * Stops a replaced request from being reported as a fault.
 *
 * `update` disposes the previous diagnostics adapter, which cancels whatever
 * validation that adapter had in flight. Monaco filters exactly this in its own
 * `onUnexpectedError`, but the throw happens on an event-dispatch stack that
 * does not pass through it, so it surfaces as an uncaught `Canceled` — a console
 * error, on a working action, every time a user corrects a file's schema.
 *
 * Deliberately the narrowest possible filter: both fields, exact strings, and
 * `preventDefault` only for that. Anything else is still a real error.
 */
export function ignoreMonacoCancellations(): void {
  window.addEventListener("error", (event) => {
    if (isMonacoCancellation(event.error)) event.preventDefault();
  });
  window.addEventListener("unhandledrejection", (event) => {
    if (isMonacoCancellation(event.reason)) event.preventDefault();
  });
}

/** The last applied associations, serialised, so a no-op change stays a no-op. */
let applied: string | null = null;

function currentSchemas(): SchemasSettings[] {
  return schemaEntries(
    payload,
    assignment.detected,
    assignment.overrides,
  ) as SchemasSettings[];
}
