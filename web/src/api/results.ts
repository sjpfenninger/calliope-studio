import { RecordBatchReader, type RecordBatch, type Table } from "apache-arrow";
import client from "./client";

/** How a chart asks for data. Changing any field re-fetches the chart. */
export interface ResultQuery {
  variable: string;
  selectors?: Record<string, string[] | null>;
  time_range?: [string, string] | null;
  resample?: string | null;
  sum_by?: string | null;
  order?: "time" | "duration";
  index?: string | null;
  drop_zeros?: boolean;
}

/** One plottable series: a column, plus the coordinates identifying it. */
export interface Series {
  key: string;
  values: Float64Array;
  dims: Record<string, string>;
  color?: string;
  unit?: string;
}

export interface ResultFrame {
  /** Index values: timestamps, category labels, or period numbers. */
  index: unknown[];
  indexName: string;
  series: Series[];
  variable: string;
  order: "time" | "duration";
  seriesDims: string[];
}

/**
 * A transmission technology and the two nodes it joins.
 *
 * `from` and `to` are null when the model does not say which end is which — a
 * link is still a link, it just goes by its own name.
 */
export interface Link {
  tech: string;
  from: string | null;
  to: string | null;
}

export interface Catalog {
  id: string;
  name: string;
  variables: {
    all: string[];
    timeseries: string[];
    static: string[];
    static_nodes: string[];
    static_links: string[];
  };
  /** Every dimension's members, `techs` still including the links. */
  dimensions: Record<string, string[]>;
  links: Link[];
  colors: Record<string, string>;
  time_extent: [string, string] | null;
  synthetic: Record<string, string>;
}

export async function fetchCatalog(handle: string): Promise<Catalog> {
  const response = await client.get<Catalog>(`/api/results/${handle}/catalog/`);
  return response.data;
}

export async function fetchGeo(handle: string) {
  const response = await client.get(`/api/results/${handle}/geo/`);
  return response.data;
}

export async function fetchSummary(handle: string) {
  const response = await client.get(`/api/results/${handle}/summary/`);
  return response.data;
}

function decodeMetadata(metadata: Map<string, string> | undefined | null) {
  const entries: Record<string, string> = {};
  metadata?.forEach((value, key) => {
    entries[key] = value;
  });
  return entries;
}

/**
 * Reads a result frame, yielding a snapshot each time a batch arrives.
 *
 * The server writes Arrow record batches as it produces them, so a chart can
 * paint the first slice while the rest is still in flight. Each yielded frame
 * is complete and self-consistent — it simply covers more of the index than the
 * one before.
 */
export async function* streamFrame(
  handle: string,
  query: ResultQuery,
  signal?: AbortSignal,
): AsyncGenerator<ResultFrame> {
  const response = await fetch(`/api/results/${handle}/frame/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(query),
    signal,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Result query failed (${response.status}): ${detail}`);
  }
  if (!response.body) throw new Error("Result response had no body");

  const reader = await RecordBatchReader.from(response.body);
  const batches: RecordBatch[] = [];

  for await (const batch of reader) {
    batches.push(batch);
    // The schema comes off the batch, not the reader: `reader.schema` is
    // undefined when the reader was built from a byte stream.
    yield toFrame(batches, batch.schema);
  }

  // A query that matches nothing still has to reach the chart, so it can say
  // "nothing to show" rather than keep displaying a stale series.
  if (batches.length === 0) yield EMPTY_FRAME;
}

const EMPTY_FRAME: ResultFrame = {
  index: [],
  indexName: "index",
  series: [],
  variable: "",
  order: "time",
  seriesDims: [],
};

function toFrame(batches: RecordBatch[], schema: Table["schema"]): ResultFrame {
  const meta = decodeMetadata(schema.metadata);
  const seriesDims: string[] = JSON.parse(meta.series_dims ?? "[]");
  const indexName = meta.index ?? schema.fields[0]?.name ?? "index";

  const index: unknown[] = [];
  const columns: unknown[][] = schema.fields.slice(1).map(() => []);

  for (const batch of batches) {
    const indexColumn = batch.getChildAt(0);
    for (let row = 0; row < batch.numRows; row += 1) {
      index.push(indexColumn?.get(row));
    }
    for (let field = 1; field < schema.fields.length; field += 1) {
      const column = batch.getChildAt(field);
      const target = columns[field - 1];
      for (let row = 0; row < batch.numRows; row += 1) {
        target.push(column?.get(row));
      }
    }
  }

  const series: Series[] = schema.fields.slice(1).map((field, position) => {
    const fieldMeta = decodeMetadata(field.metadata);
    return {
      key: field.name,
      values: Float64Array.from(
        columns[position].map((value) => (value == null ? NaN : Number(value))),
      ),
      dims: JSON.parse(fieldMeta.dims ?? "{}"),
      color: fieldMeta.color,
      unit: fieldMeta.unit,
    };
  });

  return {
    index,
    indexName,
    series,
    variable: meta.variable ?? "",
    order: (meta.order as "time" | "duration") ?? "time",
    seriesDims,
  };
}
