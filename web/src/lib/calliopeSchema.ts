/**
 * The one shape correction every consumer of Calliope's schema needs, and the
 * matching of schemas to files.
 *
 * The server generates the schemas from the installed Calliope rather than
 * checking them in, and the payload's top level is the *model definition*
 * schema — which is what Monaco's YAML integration wants — with the others
 * beside it under `x-calliope.schemas`.
 *
 * That leaves `config:` described nowhere the consumers look. A model's config
 * block is validated by a separate pydantic model, so it is not, and never will
 * be, a property of the model-definition schema. Both consumers were affected
 * and neither said so: the config editor rendered no fields at all, and Monaco
 * offered no completion for the block a user edits most.
 *
 * A *second* correction is not here, deliberately: Calliope's published schema
 * is stricter than Calliope, because its shorthands (`dims: costs`,
 * `index: monetary`, an empty technology) are implemented as pydantic
 * before-validators, which a validation-mode JSON Schema does not describe.
 * That one is applied server-side in `modeldef/schema.py`, where the payload is
 * generated and where its test can hold it against Calliope's own example
 * models. It is about Calliope disagreeing with Calliope; this file is about
 * what an editor additionally needs.
 *
 * `schemaEntries` is the second half. Calliope has four schemas and a workspace
 * has many files, and the editor used to hand Monaco a single association
 * matching `*.yaml` — so a math file was validated against the model-definition
 * schema and every key in it read as unknown. Which schema applies is a question
 * about how Calliope *reaches* a file, so the server answers it
 * (`modeldef/filekinds.py`) and this turns the answer into associations.
 */
import { compareNames } from "./fileTree";

export interface CalliopeSchema extends Record<string, any> {
  properties?: Record<string, any>;
}

/**
 * Real Calliope syntax that the model-definition schema does not describe.
 *
 * These are resolved by Calliope's file assembly *before* anything is validated:
 * `import:` is followed and removed, `overrides:` and `scenarios:` are applied
 * and removed, `templates:` is inherited from and removed. What the schema
 * describes is the model that comes out the other side.
 *
 * Correct for Calliope, and useless for an editor: every model file starts with
 * `import:`, and every one of them was being marked as an unknown key. Described
 * loosely on purpose — the point is to stop reporting valid files as broken, not
 * to invent constraints Calliope does not impose.
 */
const ASSEMBLY_KEYS: Record<string, unknown> = {
  import: { type: "array", items: { type: "string" } },
  overrides: { type: "object", additionalProperties: true },
  scenarios: { type: "object", additionalProperties: true },
  templates: { type: "object", additionalProperties: true },
};

export function withSiblingSchemas(payload: CalliopeSchema): CalliopeSchema {
  const siblings: Record<string, any> = payload["x-calliope"]?.schemas ?? {};
  const extra: Record<string, any> = {};
  if (siblings.config) extra.config = siblings.config;
  if (siblings.math) extra.math = siblings.math;

  const properties = { ...(payload.properties ?? {}), ...extra };
  for (const [key, schema] of Object.entries(ASSEMBLY_KEYS)) {
    // Never over the real thing: if a future Calliope describes one of these
    // properly, its own description wins.
    if (!(key in properties)) properties[key] = schema;
  }

  return { ...payload, properties };
}

/**
 * Which schema describes a file.
 *
 * Mirrors `modeldef/filekinds.py`; `unknown` means nothing refers to the file,
 * so no schema is applied and it is simply left alone.
 */
export type FileKind = "model" | "math" | "unknown";


/** A monaco-yaml schema association, structurally — the fields we set. */
export interface SchemaEntry {
  uri: string;
  fileMatch: string[];
  schema?: Record<string, any>;
}

const MODEL_URI = "https://calliope.readthedocs.io/schema";
const MATH_URI = "https://calliope.readthedocs.io/schema/math";

/**
 * Every section and entry tab is a model-definition fragment.
 *
 * Those editors give Monaco a `virtual:///{tabId}.yaml` URI rather than a path,
 * because they hold one section of a file rather than a file. The tab id is
 * percent-encoded and so contains no `/`, which is what lets one `*` cover all
 * of them.
 */
const VIRTUAL_MATCH = "virtual:///*";

/**
 * The Monaco URI of a real file on disk, as a string.
 *
 * A bare `file:///${path}` is wrong the moment a name contains a character a
 * URI has to escape, and wrong on *both* sides of a comparison nothing checks:
 * Monaco percent-encodes in `Uri.toString()`, so the model for `my model.yaml`
 * is `file:///my%20model.yaml` while a `fileMatch` built from the same path read
 * `file:///my model.yaml`. No match, no schema, and the only symptom is
 * completion and validation quietly absent in that one file. A `#` is worse
 * still: `Uri.parse` takes it as the start of a fragment and truncates the path.
 *
 * Encoded per segment so the separators survive, and the five sub-delims
 * `encodeURIComponent` spares are encoded as well — Monaco's own encoder returns
 * only the RFC 3986 unreserved set unescaped, and the two spellings have to
 * agree exactly or the match fails for the same invisible reason.
 */
export function fileUri(path: string): string {
  const encode = (segment: string) =>
    encodeURIComponent(segment).replace(
      /[!'()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  return `file:///${path.split("/").map(encode).join("/")}`;
}

/**
 * The effective kind of a file: what the user said, else what we detected.
 *
 * Keyed on path rather than on a detected kind, so that an override survives the
 * file being re-detected — adding it to an `import:` list changes what we think
 * it is, and must not silently discard what the user told us.
 */
export function effectiveKind(
  path: string,
  detected: Record<string, FileKind | string>,
  overrides: Record<string, FileKind>,
): FileKind {
  const chosen = overrides[path];
  if (chosen) return chosen;
  const found = detected[path];
  return found === "model" || found === "math" ? found : "unknown";
}

/**
 * Builds monaco-yaml's schema associations from a workspace's file kinds.
 *
 * One entry per schema rather than per file: `fileMatch` takes a list, and
 * monaco-yaml re-resolves all of them on every `update`, so a hundred-file model
 * is two entries and not a hundred.
 *
 * A file whose kind is `unknown` appears in no `fileMatch` at all. That is the
 * point of having the kind — assigning it an empty schema would validate it
 * against "nothing is allowed", which is worse than the model schema it used to
 * get, not better.
 */
export function schemaEntries(
  payload: CalliopeSchema | null,
  detected: Record<string, FileKind | string>,
  overrides: Record<string, FileKind> = {},
): SchemaEntry[] {
  if (!payload) return [];

  const paths = new Set([...Object.keys(detected), ...Object.keys(overrides)]);
  const byKind: Record<FileKind, string[]> = { model: [], math: [], unknown: [] };
  for (const path of paths) {
    byKind[effectiveKind(path, detected, overrides)].push(fileUri(path));
  }

  const entries: SchemaEntry[] = [
    {
      uri: MODEL_URI,
      fileMatch: [...byKind.model.sort(compareNames), VIRTUAL_MATCH],
      schema: withSiblingSchemas(payload),
    },
  ];

  const math = payload["x-calliope"]?.schemas?.math;
  if (math && byKind.math.length) {
    entries.push({ uri: MATH_URI, fileMatch: byKind.math.sort(compareNames), schema: math });
  }
  return entries;
}
