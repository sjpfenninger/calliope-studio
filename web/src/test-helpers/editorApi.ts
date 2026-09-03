/**
 * The mocked server, for the structured-editor tests.
 *
 * Deliberately imports nothing from the app. A `vi.mock` factory that
 * `import()`s this module runs while the mocked module is being resolved, and
 * if this file's own import chain reached that module — `stores/tabs` imports
 * `@/api/versions`, and a `TooltipProvider` pulls in half of `components/ui`
 * — the two loads would wait on each other for ever, with no error and no
 * output: exactly what happened when it was one file with `editors.ts`, and
 * only when `@/api/system` happened to be the first import in the test.
 *
 * A factory has to answer for *every* function the mounted tree calls: one
 * left out is `undefined` at call time, and the failure names the store that
 * called it rather than the mock that forgot it. These are the lists.
 */
import { vi } from "vitest";

/** What `/geo/` answers for a model with nothing placed. */
export const EMPTY_GEO = {
  nodes: { type: "FeatureCollection" as const, features: [] },
  links: { type: "FeatureCollection" as const, features: [] },
  bounds: null,
};

/** The `@/api/versions` surface the editors and their stores reach. */
export function versionsApi() {
  return {
    readYamlSection: vi.fn(),
    putYamlSection: vi.fn(),
    readOverrides: vi.fn(),
    putOverrides: vi.fn(),
    getDataTableParams: vi.fn(),
    getGeo: vi.fn(),
    getComponentTree: vi.fn(),
    getTemplates: vi.fn(),
    getCsv: vi.fn(),
    putCsv: vi.fn(),
    getSolvers: vi.fn(),
    getSettings: vi.fn(),
    patchSettings: vi.fn(),
    getScenarioCatalog: vi.fn(),
  };
}

/** The `@/api/system` surface: the schema store is the only caller here. */
export function systemApi() {
  return { getCalliopeSchema: vi.fn() };
}

export type VersionsApi = ReturnType<typeof versionsApi>;
export type SystemApi = ReturnType<typeof systemApi>;

/**
 * Puts the mocks back to a model with nothing in it.
 *
 * `vi.clearAllMocks` keeps implementations, so a `mockResolvedValue` set by one
 * test would otherwise leak into the next; `mockReset` alone leaves every call
 * answering `undefined`, and `templates.value = undefined` breaks the first
 * editor to index it.
 */
export function resetVersionsApi(api: VersionsApi): void {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getDataTableParams.mockResolvedValue({});
  api.getGeo.mockResolvedValue(EMPTY_GEO);
  api.getComponentTree.mockResolvedValue({});
  api.getTemplates.mockResolvedValue({});
  api.getSolvers.mockResolvedValue([]);
  api.putYamlSection.mockResolvedValue("r2");
  api.putOverrides.mockResolvedValue("r2");
}

/** What the section endpoint answers: the data, and the file's revision. */
export function section(data: Record<string, unknown>, revision = "r1") {
  return { data, revision };
}
