/**
 * How a data table's contribution to one entity is described.
 *
 * `GET /versions/{id}/data-table-params/` reports each parameter with the
 * dimensions it is indexed on *besides* the entity's own, which is what makes an
 * honest display possible. A `(nodes, techs)` parameter is not a parameter of the
 * node — it belongs to a technology *at* that node — and the reader used to present
 * one anyway, valued from whichever technology's row came last. `NLD111` was told
 * it had `flow_cap_max = 0.0058`.
 *
 * So: a value when there is exactly one, and otherwise a description of what the
 * table actually indexes it by.
 */

export interface DataTableParam {
  value: any;
  time_varying: boolean;
  source: string;
  /** Dimensions besides the entity's own. Absent from an older server. */
  dims?: string[];
  /** Which member, for a dimension with only one — `{costs: "monetary"}`. */
  index?: Record<string, string>;
}

/** What to show for one parameter: a value, or why there is not a single one. */
export function describeParam(param: DataTableParam): string {
  const dims = param.dims ?? [];
  if (param.value !== null && param.value !== undefined) {
    const qualifier = Object.values(param.index ?? {}).join(", ");
    return qualifier ? `${param.value} (${qualifier})` : String(param.value);
  }
  if (param.time_varying) {
    const others = dims.filter((dim) => dim !== "timesteps");
    return others.length ? `time-varying, per ${others.join(", ")}` : "time-varying";
  }
  if (dims.length) return `per ${dims.join(", ")}`;
  return String(param.value);
}

/** `{parameter: description}` for one entity's data-table parameters. */
export function describeParams(
  params: Record<string, DataTableParam> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params ?? {}).map(([key, param]) => [key, describeParam(param)]),
  );
}

/** `{parameter: table}`, for showing where each came from. */
export function paramSources(
  params: Record<string, DataTableParam> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params ?? {}).map(([key, param]) => [key, param.source]),
  );
}
