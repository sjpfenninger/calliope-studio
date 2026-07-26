import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import client from "../api/client";
import { useSchemaStore } from "./schema";

vi.mock("../api/client", () => ({ default: { get: vi.fn() } }));

const api = vi.mocked(client, true);

/**
 * The schema store, which decides what the structured editors can even show.
 *
 * Two things here were silently broken for the life of this code: the `$ref`
 * cycle guard had no test exercising it, and the `config` schema was addressed
 * at a path the payload never had — so the config editor rendered every field it
 * was asked to and none it was supposed to infer.
 */
describe("useSchemaStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    api.get.mockReset();
  });

  it("finds config.init, which lives beside the model schema, not inside it", async () => {
    // A Calliope model's `config:` block is validated by a separate pydantic
    // model, so it is never a property of the model-definition schema. Without
    // grafting it in, the config editor showed nothing at all.
    api.get.mockResolvedValue({
      data: {
        properties: { techs: { type: "object" } },
        "x-calliope": {
          schemas: {
            config: {
              properties: {
                init: { properties: { name: { type: "string" } } },
              },
            },
          },
        },
      },
    });

    const store = useSchemaStore();
    await store.load();

    expect(store.subschema("config.init")?.properties).toEqual({
      name: { type: "string" },
    });
  });

  it("still finds the model schema's own sections", async () => {
    api.get.mockResolvedValue({
      data: { properties: { data_tables: { patternProperties: { ".*": {} } } } },
    });

    const store = useSchemaStore();
    await store.load();

    expect(store.subschema("data_tables")).toHaveProperty("patternProperties");
  });

  it("resolves a $ref and keeps the sibling keys", async () => {
    api.get.mockResolvedValue({
      data: {
        properties: {
          solve: { $ref: "#/$defs/Solve", description: "how to solve" },
        },
        $defs: { Solve: { type: "object", description: "generic" } },
      },
    });

    const store = useSchemaStore();
    await store.load();

    const solve = store.subschema("solve");
    expect(solve?.type).toBe("object");
    // The sibling wins: it is the more specific of the two.
    expect(solve?.description).toBe("how to solve");
  });

  it("survives a schema that refers to itself", async () => {
    // Calliope's own schemas contain recursive definitions; without the guard
    // this recurses until the stack gives out, taking the editor with it.
    api.get.mockResolvedValue({
      data: {
        properties: { node: { $ref: "#/$defs/Node" } },
        $defs: {
          Node: {
            type: "object",
            properties: { child: { $ref: "#/$defs/Node" } },
          },
        },
      },
    });

    const store = useSchemaStore();
    await store.load();

    expect(store.subschema("node")?.type).toBe("object");
    expect(store.isLoaded).toBe(true);
  });

  it("degrades quietly when the schema cannot be fetched", async () => {
    // An editor with no schema shows the fields it draws by hand; an editor that
    // threw would show nothing at all.
    api.get.mockRejectedValue(new Error("503"));

    const store = useSchemaStore();
    await store.load();

    expect(store.isLoaded).toBe(false);
    expect(store.subschema("config.init")).toBeNull();
  });

  it("returns null for a path that is not there", async () => {
    api.get.mockResolvedValue({ data: { properties: {} } });
    const store = useSchemaStore();
    await store.load();
    expect(store.subschema("config.init")).toBeNull();
  });
});
