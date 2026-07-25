import { ref } from "vue";
import { defineStore } from "pinia";
import client from "../api/client";

export const useSchemaStore = defineStore("schema", () => {
  const resolved = ref<Record<string, any> | null>(null);
  const isLoaded = ref(false);

  /** Recursively resolve all $ref pointers using the schema's $defs. */
  function deref(
    obj: any,
    defs: Record<string, any>,
    visited: Set<string> = new Set()
  ): any {
    if (obj === null || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map((item) => deref(item, defs, visited));

    if ("$ref" in obj) {
      const refStr = obj.$ref as string;
      // Merge non-$ref sibling keys (e.g. "default", "description") with resolved def.
      const rest = Object.fromEntries(
        Object.entries(obj).filter(([k]) => k !== "$ref")
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
      Object.entries(obj).map(([k, v]) => [k, deref(v, defs, visited)])
    );
  }

  /** Fetch the Calliope schema from the API and deref it in place. */
  async function load() {
    if (isLoaded.value) return;
    try {
      const res = await client.get<Record<string, any>>("/api/schema/calliope/");
      const schema = res.data;
      const defs: Record<string, any> = schema.$defs ?? schema.definitions ?? {};
      resolved.value = deref(schema, defs);
      isLoaded.value = true;
    } catch {
      // Schema unavailable — editors degrade gracefully (no auto-detected fields).
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

  return { resolved, isLoaded, load, subschema };
});
