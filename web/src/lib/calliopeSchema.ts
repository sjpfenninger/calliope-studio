/**
 * The one shape correction every consumer of Calliope's schema needs.
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
 */

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
