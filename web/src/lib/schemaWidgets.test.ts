/**
 * What breaks if this is wrong: the config editor writes a value the model
 * cannot load, or rewrites a value the user never touched.
 *
 * Both have happened. `shadow_prices` and `extra_math` are `type: array` at the
 * top level, which the old detection did not handle at all — they fell through
 * to a plain text field that rendered `String(list)` and wrote a bare string
 * back. `solver_options` is an object with no `properties`, which took the
 * recursive-form path and rendered an empty box. And `add_dims`/`select` in the
 * data-tables editor, which have been on the `keyValue` widget all along,
 * displayed a list as `a,b` and wrote the *string* `"a,b"` on the next edit.
 *
 * The schema fragments below are copied verbatim from the installed Calliope
 * 0.7.0 (`CalliopeConfig.model_no_ref_schema()` and `CalliopeDataTable`), minus
 * `title`/`description`. Paraphrasing them would test the paraphrase.
 */
import { describe, expect, it } from "vitest";

import {
  describeValue,
  detectWidget,
  flushRows,
  formatValue,
  parseList,
  parseValue,
  rangeParts,
  rangeText,
  rowsFromValue,
  scalarAllowed,
  unknownKeys,
  valueSchemaOf,
} from "./schemaWidgets";

const KEY_PATTERN = "^[^_^\\d][\\w]*$";

/** Calliope's config properties, as the schema actually declares them. */
const CONFIG = {
  name: { anyOf: [{ type: "string" }, { type: "null" }], default: null },
  calliope_version: { anyOf: [{ type: "string" }, { type: "null" }], default: null },
  broadcast_input_data: { default: false, type: "boolean" },
  retain_inactive: { default: false, type: "boolean" },
  subset: {
    patternProperties: {
      [KEY_PATTERN]: {
        anyOf: [
          {
            items: {
              anyOf: [{ type: "string" }, { type: "integer" }, { type: "number" }],
            },
            minItems: 1,
            type: "array",
          },
          { type: "null" },
        ],
      },
    },
    type: "object",
  },
  resample: {
    patternProperties: {
      [KEY_PATTERN]: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
    type: "object",
  },
  time_cluster: {
    anyOf: [{ pattern: KEY_PATTERN, type: "string" }, { type: "null" }],
    default: null,
  },
  datetime_format: { default: "ISO8601", type: "string" },
  date_format: { default: "ISO8601", type: "string" },
  distance_unit: { default: "km", enum: ["km", "m"], type: "string" },
  mode: { default: "base", enum: ["base", "operate", "spores"], type: "string" },
  extra_math: { items: { type: "string" }, type: "array", uniqueItems: true },
  math_paths: {
    patternProperties: { [KEY_PATTERN]: { format: "path", type: "string" } },
    type: "object",
  },
  pre_validate_math_strings: { default: false, type: "boolean" },
  backend: { default: "pyomo", enum: ["pyomo", "gurobi", "highs"], type: "string" },
  ensure_feasibility: { default: false, type: "boolean" },
  objective: { default: "min_cost_optimisation", type: "string" },
  operate: {
    additionalProperties: false,
    properties: {
      window: { default: "24h", type: "string" },
      horizon: { default: "48h", type: "string" },
    },
    type: "object",
  },
  postprocessing_active: { default: true, type: "boolean" },
  save_logs: {
    anyOf: [{ format: "path", type: "string" }, { type: "null" }],
    default: null,
  },
  shadow_prices: { items: { type: "string" }, type: "array", uniqueItems: true },
  solver: { default: "cbc", type: "string" },
  solver_io: { anyOf: [{ type: "string" }, { type: "null" }], default: null },
  solver_options: { additionalProperties: true, type: "object" },
  spores: {
    additionalProperties: false,
    properties: {
      scoring_algorithm: { default: "integer", enum: ["integer", "random"], type: "string" },
      number: { default: 3, type: "integer" },
    },
    type: "object",
  },
  zero_threshold: { default: 1e-10, type: "number" },
} as const;

/** The data-tables editor is the second consumer of the mapping widget. */
const DATA_TABLE = {
  rows: {
    anyOf: [
      { pattern: KEY_PATTERN, type: "string" },
      { items: { pattern: KEY_PATTERN, type: "string" }, type: "array", uniqueItems: true },
      { type: "null" },
    ],
    default: null,
  },
  add_dims: {
    anyOf: [
      {
        patternProperties: {
          [KEY_PATTERN]: {
            anyOf: [
              { pattern: KEY_PATTERN, type: "string" },
              { items: { pattern: KEY_PATTERN, type: "string" }, type: "array" },
            ],
          },
        },
        type: "object",
      },
      { type: "null" },
    ],
    default: null,
  },
} as const;

describe("detectWidget", () => {
  it("gives every Calliope config property a control that can hold its value", () => {
    const expected: Record<string, string> = {
      // The two regressions this module exists for.
      extra_math: "commaSeparated",
      shadow_prices: "commaSeparated",
      solver_options: "keyValue",
      // An object is a nested form only when it enumerates its own properties.
      operate: "object",
      spores: "object",
      subset: "keyValue",
      resample: "keyValue",
      math_paths: "keyValue",
      // `X | null` is the property wearing an optionality marker, nothing more.
      name: "text",
      calliope_version: "text",
      save_logs: "text",
      solver_io: "text",
      time_cluster: "text",
      // The plain ones.
      datetime_format: "text",
      date_format: "text",
      objective: "text",
      solver: "text",
      mode: "select",
      distance_unit: "select",
      backend: "select",
      zero_threshold: "number",
      broadcast_input_data: "switch",
      retain_inactive: "switch",
      pre_validate_math_strings: "switch",
      ensure_feasibility: "switch",
      postprocessing_active: "switch",
    };
    // Every property is accounted for, so a Calliope upgrade adding one fails here.
    expect(Object.keys(expected).sort()).toEqual(Object.keys(CONFIG).sort());
    for (const [key, widget] of Object.entries(expected)) {
      expect(detectWidget(CONFIG[key as keyof typeof CONFIG]), key).toBe(widget);
    }
  });

  it("keeps the data-tables editor's shapes, which it has always had explicitly", () => {
    expect(detectWidget(DATA_TABLE.rows)).toBe("commaSeparated");
    expect(detectWidget(DATA_TABLE.add_dims)).toBe("keyValue");
  });

  it("falls back to text for a schema that says nothing, without recursing", () => {
    expect(detectWidget({})).toBe("text");
  });
});

describe("valueSchemaOf", () => {
  it("descends through the anyOf a data table wraps its mapping in", () => {
    // `add_dims` is `{patternProperties: …} | null`; config's mappings are not
    // wrapped, so reading the top level alone answers for only one of the two.
    expect(valueSchemaOf(DATA_TABLE.add_dims)).toEqual(
      DATA_TABLE.add_dims.anyOf[0].patternProperties[KEY_PATTERN],
    );
    expect(valueSchemaOf(CONFIG.math_paths)).toEqual({ format: "path", type: "string" });
  });

  it("reads an open mapping as an unconstrained value", () => {
    expect(valueSchemaOf(CONFIG.solver_options)).toEqual({});
  });
});

describe("scalarAllowed", () => {
  it("refuses to collapse a one-item list the schema declares as a list", () => {
    // `shadow_prices: system_balance` is not a model Calliope will load.
    expect(scalarAllowed(CONFIG.shadow_prices)).toBe(false);
    expect(scalarAllowed(CONFIG.extra_math)).toBe(false);
    expect(scalarAllowed(valueSchemaOf(CONFIG.subset))).toBe(false);
  });

  it("allows it where Calliope's own files are written that way", () => {
    expect(scalarAllowed(DATA_TABLE.rows)).toBe(true);
    expect(scalarAllowed(valueSchemaOf(DATA_TABLE.add_dims))).toBe(true);
  });
});

describe("parseValue", () => {
  it("writes a list for a list-only property, however few items", () => {
    expect(parseValue(CONFIG.shadow_prices, "system_balance")).toEqual(["system_balance"]);
    expect(parseValue(CONFIG.extra_math, "dispatch")).toEqual(["dispatch"]);
  });

  it("collapses to a scalar only where a scalar is valid", () => {
    expect(parseValue(DATA_TABLE.rows, "techs")).toBe("techs");
    expect(parseValue(DATA_TABLE.rows, "techs, nodes")).toEqual(["techs", "nodes"]);
  });

  it("drops duplicates the schema declares unique", () => {
    expect(parseValue(CONFIG.extra_math, "a, b, a")).toEqual(["a", "b"]);
  });

  it("reads an empty field as the absence of the key", () => {
    expect(parseValue(CONFIG.shadow_prices, "  ")).toBeNull();
    expect(parseValue(CONFIG.datetime_format, "")).toBeNull();
  });

  it("types an open mapping's value without rewriting what was typed", () => {
    const open = valueSchemaOf(CONFIG.solver_options);
    expect(parseValue(open, "4")).toBe(4);
    expect(parseValue(open, "1e-9")).toBe(1e-9);
    expect(parseValue(open, "true")).toBe(true);
    // A leading zero survives `Number()` and would not survive coming back, so
    // converting it would rewrite the user's value rather than read it.
    expect(parseValue(open, "04")).toBe("04");
    expect(parseValue(open, "barrier")).toBe("barrier");
  });

  it("keeps a numeric property numeric and a string property a string", () => {
    expect(parseValue(CONFIG.zero_threshold, "1e-10")).toBe(1e-10);
    expect(parseValue(CONFIG.datetime_format, "%Y-%m-%d")).toBe("%Y-%m-%d");
  });

  it("reads only a YAML number as a number in a numeric property", () => {
    // `Number()` accepts all three; JSON carries the first as `null`, and the
    // second would be rewritten as 26. `.inf` is the spelling the server
    // turns back into infinity, so it must reach it as text.
    expect(parseValue(CONFIG.zero_threshold, "Infinity")).toBe("Infinity");
    expect(parseValue(CONFIG.zero_threshold, "0x1A")).toBe("0x1A");
    expect(parseValue(CONFIG.zero_threshold, ".inf")).toBe(".inf");
    expect(parseValue(CONFIG.zero_threshold, "-3.5")).toBe(-3.5);
  });
});

describe("format/parse round trip", () => {
  /** Values these two real models actually carry in their config blocks. */
  const cases: Array<[string, Record<string, any>, unknown]> = [
    ["extra_math", CONFIG.extra_math, ["dispatch"]],
    ["shadow_prices", CONFIG.shadow_prices, ["system_balance"]],
    ["datetime_format", CONFIG.datetime_format, "%Y-%m-%d %H:%M:%S+00:00"],
    ["calliope_version", CONFIG.calliope_version, "0.7.0"],
    ["zero_threshold", CONFIG.zero_threshold, 1e-10],
    ["subset value", valueSchemaOf(CONFIG.subset), ["2020-01-01", "2020-12-31"]],
    ["math_paths value", valueSchemaOf(CONFIG.math_paths), "custom-math.yaml"],
    ["add_dims value", valueSchemaOf(DATA_TABLE.add_dims), ["a", "b"]],
    ["rows", DATA_TABLE.rows, "techs"],
    ["rows list", DATA_TABLE.rows, ["inputs", "nodes"]],
  ];

  it.each(cases)("survives a no-op edit of %s", (_name, schema, value) => {
    expect(parseValue(schema, formatValue(value))).toEqual(value);
  });
});

describe("flushRows", () => {
  const open = valueSchemaOf(CONFIG.solver_options);

  it("emits an untouched row's value verbatim, whatever the text would parse to", () => {
    // The failure: editing `threads` reparsed `mip_start` and turned a
    // deliberate string into a number, on a save that never touched it.
    const rows = rowsFromValue({ mip_start: "4", threads: 8 });
    rows[1]!.text = "16";
    expect(flushRows(rows, open)).toEqual({ mip_start: "4", threads: 16 });
  });

  it("parses a row the user did edit", () => {
    const rows = rowsFromValue({ threads: "4" });
    rows[0]!.text = "8";
    expect(flushRows(rows, open)).toEqual({ threads: 8 });
  });

  it("keeps a value when its key is renamed", () => {
    const rows = rowsFromValue({ old: "04" });
    rows[0]!.key = "new";
    expect(flushRows(rows, open)).toEqual({ new: "04" });
  });

  it("skips a row with no key, and reads an empty mapping as no key at all", () => {
    expect(flushRows([{ key: "  ", text: "x" }], open)).toBeNull();
    expect(flushRows([], open)).toBeNull();
  });

  it("marshals a list-valued mapping as a list", () => {
    const valueSchema = valueSchemaOf(CONFIG.subset);
    const rows = rowsFromValue({ timesteps: ["2020-01-01", "2020-12-31"] });
    rows[0]!.text = "2020-01-01, 2020-06-30";
    expect(flushRows(rows, valueSchema)).toEqual({
      timesteps: ["2020-01-01", "2020-06-30"],
    });
  });
});

describe("rangeParts / rangeText", () => {
  it("splits a two-item list into a start and an end", () => {
    expect(rangeParts("2020-01-01, 2020-12-31")).toEqual(["2020-01-01", "2020-12-31"]);
    expect(rangeParts("")).toEqual(["", ""]);
  });

  it("drops an empty half rather than writing a blank item", () => {
    expect(rangeText("2020-01-01", "")).toBe("2020-01-01");
    expect(rangeText("", "")).toBe("");
    expect(rangeText(" a ", " b ")).toBe("a, b");
  });
});

describe("unknownKeys", () => {
  const schema = { properties: CONFIG };

  it("names a key Calliope's schema does not describe", () => {
    // The pre-0.7 spelling, still found in real models.
    expect(unknownKeys(schema, { name: "m", time_subset: ["a", "b"] })).toEqual([
      "time_subset",
    ]);
  });

  it("says nothing when the schema never arrived", () => {
    // `stores/schema.ts` swallows a failed fetch, so the editors see `{}`. Every
    // key in the model reading as unrecognised is a wall of warnings about a
    // network blip.
    expect(unknownKeys({}, { name: "m" })).toEqual([]);
    expect(unknownKeys({ properties: {} }, { name: "m" })).toEqual([]);
  });

  it("says nothing about a fully described object", () => {
    expect(unknownKeys(schema, { name: "m", mode: "base" })).toEqual([]);
  });
});

describe("parseList", () => {
  it("trims, drops empties, and dedupes only when asked", () => {
    expect(parseList(" a , b ,, ")).toEqual(["a", "b"]);
    expect(parseList("a, a")).toEqual(["a", "a"]);
    expect(parseList("a, a", { unique: true })).toEqual(["a"]);
  });
});

describe("describeValue", () => {
  it("reads a mapping as prose rather than as JSON", () => {
    // What the read-only `math_paths` row shows. `{"dispatch":"…"}` is a
    // correct rendering of the value and a poor rendering of the fact.
    expect(describeValue({ dispatch: "custom-math.yaml" })).toBe(
      "dispatch: custom-math.yaml",
    );
    expect(describeValue({ a: ["x", "y"], b: 1 })).toBe("a: x, y, b: 1");
  });

  it("defers to formatValue for everything else", () => {
    expect(describeValue(["a", "b"])).toBe("a, b");
    expect(describeValue(null)).toBe("");
  });
});

describe("formatValue", () => {
  it("reads a value as the text of an input", () => {
    expect(formatValue(["a", "b"])).toBe("a, b");
    expect(formatValue(null)).toBe("");
    expect(formatValue(1e-10)).toBe("1e-10");
    expect(formatValue(false)).toBe("false");
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
  });
});
