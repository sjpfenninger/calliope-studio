import { ref } from "vue";
import { defineStore } from "pinia";
import { getCalliopeSchema, getSolvers } from "../api/system";
import { withSiblingSchemas } from "../lib/calliopeSchema";

/**
 * Calliope's own schemas, resolved once and navigated by path.
 *
 * The server generates these from the installed Calliope rather than checking
 * them in, so they can never describe a different version from the one that will
 * run the model. The payload's top level is the *model definition* schema —
 * which is what Monaco's YAML integration wants — with the others (config, math,
 * data tables) alongside it under `x-calliope.schemas`.
 *
 * That shape is why `config` is grafted in below. `subschema("config.init")`
 * looks for `properties.config`, which the model schema does not have and never
 * will: a Calliope model's `config:` block is validated by a separate pydantic
 * model. Without the graft the config editor rendered no fields at all — only
 * the one field it draws by hand.
 */
export const useSchemaStore = defineStore("schema", () => {
  const resolved = ref<Record<string, any> | null>(null);
  const isLoaded = ref(false);

  /**
   * Solvers this machine can actually run, for the config editor to suggest.
   *
   * Kept here because the store already answers "what does the installed
   * Calliope allow", and this is the other half of the same question — what it
   * can be asked to do here. Loaded separately from `load()`, though: every
   * editor that mounts Monaco calls that, and only the config editor wants this.
   */
  const solvers = ref<string[]>([]);
  const solversLoaded = ref(false);

  /** Recursively resolve all $ref pointers using the schema's $defs. */
  function deref(
    obj: any,
    defs: Record<string, any>,
    visited: Set<string> = new Set(),
  ): any {
    if (obj === null || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map((item) => deref(item, defs, visited));

    if ("$ref" in obj) {
      const refStr = obj.$ref as string;
      // Merge non-$ref sibling keys (e.g. "default", "description") with resolved def.
      const rest = Object.fromEntries(
        Object.entries(obj).filter(([k]) => k !== "$ref"),
      );
      if (visited.has(refStr)) {
        // Cycle guard — return just the sibling keys to avoid infinite recursion.
        return deref(rest, defs, visited);
      }
      const newVisited = new Set(visited);
      newVisited.add(refStr);
      const defName = refStr.replace(/^#\/\$defs\//, "");
      const definition = defs[defName];
      if (!definition) return deref(rest, defs, newVisited);
      const resolvedDef = deref(definition, defs, newVisited);
      const resolvedRest = deref(rest, defs, newVisited);
      // Sibling properties (like "default") take precedence over the resolved def.
      return { ...resolvedDef, ...resolvedRest };
    }

    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, deref(v, defs, visited)]),
    );
  }

  /** Fetch the Calliope schema from the API and deref it in place. */
  async function load() {
    if (isLoaded.value) return;
    try {
      const schema = withSiblingSchemas(await getCalliopeSchema());
      const defs: Record<string, any> = schema.$defs ?? schema.definitions ?? {};
      // Nothing to resolve, in every payload this actually receives: Calliope's
      // `model_no_ref_schema` inlines every `$ref` and then deletes `$defs`, so
      // `deref` walked 80 KB to rebuild it unchanged. Kept behind the check
      // rather than deleted — it is the only thing standing between a schema
      // that does carry refs and a config editor rendering `$ref` as a field.
      resolved.value = Object.keys(defs).length ? deref(schema, defs) : schema;
      isLoaded.value = true;
    } catch {
      // Schema unavailable — editors degrade gracefully (no auto-detected fields).
    }
  }

  /** Fetch the solver list. Failure leaves the field free text with no menu. */
  async function loadSolvers() {
    if (solversLoaded.value) return;
    try {
      solvers.value = await getSolvers();
      solversLoaded.value = true;
    } catch {
      // Nothing to suggest — the field still accepts any name.
    }
  }

  /**
   * Navigate the resolved schema by dot-notation path through `properties`.
   * e.g. subschema("config.init") → the fully-resolved Init object schema.
   */
  function subschema(path: string): Record<string, any> | null {
    if (!resolved.value) return null;
    let cursor: Record<string, any> = resolved.value;
    for (const segment of path.split(".")) {
      const next = cursor.properties?.[segment] ?? cursor[segment];
      if (next == null) return null;
      cursor = next;
    }
    return cursor;
  }

  return { resolved, isLoaded, solvers, load, loadSolvers, subschema };
});
