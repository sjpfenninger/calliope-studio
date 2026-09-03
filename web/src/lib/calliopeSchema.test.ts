import { describe, expect, it } from "vitest";

import {
  effectiveKind,
  fileUri,
  schemaEntries,
  withSiblingSchemas,
  type CalliopeSchema,
} from "./calliopeSchema";

/**
 * Matching Calliope's schemas to a workspace's files.
 *
 * The editor used to hand Monaco one association matching `*.yaml`, which is all
 * a single `fileMatch` can say. A math file was therefore validated against the
 * model-definition schema and every key in it reported as unknown.
 */
const payload = (): CalliopeSchema => ({
  properties: { techs: { type: "object" }, nodes: { type: "object" } },
  "x-calliope": {
    schemas: {
      config: { type: "object", properties: { init: {} } },
      math: { type: "object", properties: { constraints: {} } },
    },
  },
});

const uris = (entries: ReturnType<typeof schemaEntries>) =>
  Object.fromEntries(entries.map((entry) => [entry.uri, entry.fileMatch]));

describe("withSiblingSchemas", () => {
  it("grafts config in, which the model schema will never describe", () => {
    // A model's `config:` block is validated by a separate pydantic model, so
    // without this the config editor rendered no fields and Monaco offered no
    // completion for the block a user edits most.
    expect(withSiblingSchemas(payload()).properties?.config).toBeDefined();
  });

  it("describes the assembly keys Calliope resolves before validating", () => {
    // Every model file starts with `import:`, and every one of them was being
    // marked as having an unknown key.
    const properties = withSiblingSchemas(payload()).properties ?? {};
    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining(["import", "overrides", "scenarios", "templates"]),
    );
  });

  it("never describes one over Calliope's own description of it", () => {
    const own = payload();
    own.properties!.import = { type: "string", description: "the real one" };
    expect(withSiblingSchemas(own).properties?.import).toEqual(own.properties!.import);
  });
});

describe("effectiveKind", () => {
  it("prefers what the user said to what we detected", () => {
    expect(effectiveKind("a.yaml", { "a.yaml": "unknown" }, { "a.yaml": "math" })).toBe(
      "math",
    );
  });

  it("keeps an override when detection later disagrees", () => {
    // Adding a file to an `import:` list changes what we detect. It must not
    // silently discard what the user told us.
    expect(effectiveKind("a.yaml", { "a.yaml": "model" }, { "a.yaml": "math" })).toBe(
      "math",
    );
  });

  it("treats anything it does not recognise as unknown", () => {
    expect(effectiveKind("a.yaml", { "a.yaml": "nonsense" }, {})).toBe("unknown");
    expect(effectiveKind("missing.yaml", {}, {})).toBe("unknown");
  });
});

describe("fileUri", () => {
  /**
   * Monaco percent-encodes a URI on the way out of `Uri.toString()`, and
   * monaco-yaml matches `fileMatch` against exactly that string. The two are
   * built here and in `monacoBuffer` from the same path, so if this spelling
   * differs from Monaco's the file matches nothing and loses its schema — with
   * no error anywhere, just completion and validation absent in one file.
   *
   * Monaco cannot be imported into a unit test, so the encoded form is pinned
   * literally: these strings *are* the contract, and what they have to equal is
   * `monaco.Uri.parse(fileUri(path)).toString()`.
   */
  it("encodes what Monaco would encode, and nothing else", () => {
    expect(fileUri("model.yaml")).toBe("file:///model.yaml");
    expect(fileUri("my model.yaml")).toBe("file:///my%20model.yaml");
    // A `#` is the worst case: left raw, `Uri.parse` reads it as the start of a
    // fragment and the path is truncated before the extension.
    expect(fileUri("draft #2.yaml")).toBe("file:///draft%20%232.yaml");
    // The five sub-delims `encodeURIComponent` spares; Monaco encodes them.
    expect(fileUri("a!'()*.yaml")).toBe("file:///a%21%27%28%29%2A.yaml");
  });

  it("keeps the separators between segments", () => {
    // Per segment, not over the whole path: a `/` encoded to `%2F` would name a
    // file with a slash in its name, which is not what any of these are.
    expect(fileUri("model config/tech defs.yaml")).toBe(
      "file:///model%20config/tech%20defs.yaml",
    );
  });
});

describe("schemaEntries", () => {
  it("points each schema at only the files it describes", () => {
    const entries = schemaEntries(payload(), {
      "model.yaml": "model",
      "model_config/techs.yaml": "model",
      "additional_math.yaml": "math",
    });

    const matched = uris(entries);
    expect(matched["https://calliope.readthedocs.io/schema"]).toEqual(
      expect.arrayContaining(["file:///model.yaml", "file:///model_config/techs.yaml"]),
    );
    expect(matched["https://calliope.readthedocs.io/schema/math"]).toEqual([
      "file:///additional_math.yaml",
    ]);
  });

  it("keeps a math file out of the model schema's matches", () => {
    // The whole point: this is what made every key of `additional_math.yaml`
    // report as unknown.
    const entries = schemaEntries(payload(), { "additional_math.yaml": "math" });
    const model = entries.find((entry) => entry.uri.endsWith("/schema"));
    expect(model?.fileMatch).not.toContain("file:///additional_math.yaml");
  });

  it("matches every virtual tab against the model schema", () => {
    // Section and entry editors hold a fragment of a model definition and give
    // Monaco a `virtual:///` URI rather than a path.
    const entries = schemaEntries(payload(), {});
    expect(entries[0].fileMatch).toContain("virtual:///*");
  });

  it("leaves an unknown file out of every association", () => {
    // Not an empty schema, which would validate it against "nothing is allowed"
    // — worse than the model schema it used to get, not better.
    const entries = schemaEntries(payload(), { "scratch.yaml": "unknown" });
    for (const entry of entries) {
      expect(entry.fileMatch).not.toContain("file:///scratch.yaml");
    }
  });

  it("honours an override over detection", () => {
    const entries = schemaEntries(
      payload(),
      { "scratch.yaml": "unknown" },
      { "scratch.yaml": "math" },
    );
    expect(uris(entries)["https://calliope.readthedocs.io/schema/math"]).toEqual([
      "file:///scratch.yaml",
    ]);
  });

  it("spells a path with a space the way Monaco will", () => {
    // The association is matched against the model's `Uri.toString()`, which is
    // percent-encoded; an unencoded entry here matches nothing at all.
    const entries = schemaEntries(payload(), { "my model.yaml": "model" });
    expect(entries[0].fileMatch).toContain("file:///my%20model.yaml");
  });

  it("offers no math association when nothing is math", () => {
    const entries = schemaEntries(payload(), { "model.yaml": "model" });
    expect(entries).toHaveLength(1);
  });

  it("returns nothing at all without a payload", () => {
    // The schema endpoint can 503 on a broken Calliope install. Monaco works
    // fine without one; it just offers no completion.
    expect(schemaEntries(null, { "model.yaml": "model" })).toEqual([]);
  });
});
