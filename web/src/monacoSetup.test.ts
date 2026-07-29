import { beforeEach, describe, expect, it, vi } from "vitest";

// monaco-editor and its two workers are aliased away by `vite.config.ts`, since
// they have no node-resolvable entry at all. Only monaco-yaml needs a factory:
// what is under test is how many times `configureMonacoYaml` is called.
// Hoisted, because `vi.mock` factories are lifted above every declaration in
// the file — a plain `const` here would be in its temporal dead zone by the
// time the factory runs.
const { configureMonacoYaml, update } = vi.hoisted(() => {
  const update = vi.fn();
  return { update, configureMonacoYaml: vi.fn(() => ({ update, dispose: vi.fn() })) };
});
vi.mock("monaco-yaml", () => ({ configureMonacoYaml }));

/** The payload shape the two consumers read; the contents do not matter here. */
const PAYLOAD = {
  type: "object",
  properties: { techs: { type: "object" } },
  "x-calliope": { schemas: { math: { type: "object" } } },
};

/**
 * Loads a fresh copy, because the guard under test is module-level state.
 *
 * `resetModules` alone is not enough — the import has to happen after it, so
 * each case gets its own `starting`, `configured` and `applied`.
 */
async function freshSetup() {
  vi.resetModules();
  return import("./monacoSetup");
}

/**
 * That monaco-yaml is configured exactly once, however often the shell asks.
 *
 * Every `configureMonacoYaml` registers its own hover and completion providers
 * (among a dozen others) and disposes none of the previous set, and Monaco
 * merges providers rather than replacing them — so a second call makes the
 * editor show every schema description twice and every suggestion twice, which
 * is precisely what a user reported. It is reachable from ordinary navigation:
 * `AppShell` calls this from `onMounted`, and it is registered as two route
 * records, so leaving a model for the recents list and opening one again is
 * enough.
 */
describe("initMonacoYaml", () => {
  beforeEach(() => {
    configureMonacoYaml.mockClear();
    update.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => PAYLOAD })),
    );
  });

  it("configures monaco-yaml once, however many times the shell mounts", async () => {
    const { initMonacoYaml } = await freshSetup();

    await initMonacoYaml();
    await initMonacoYaml();
    await initMonacoYaml();

    expect(configureMonacoYaml).toHaveBeenCalledTimes(1);
  });

  it("holds against two mounts that overlap the schema fetch", async () => {
    // The case a `if (configured) return` guard does not catch, and the reason
    // the guard is the promise: both callers reach the check while the fetch
    // started by the first is still in flight, so neither sees an instance yet.
    const { initMonacoYaml } = await freshSetup();

    await Promise.all([initMonacoYaml(), initMonacoYaml()]);

    expect(configureMonacoYaml).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("restates changed associations in place rather than reconfiguring", async () => {
    // `update` is monaco-yaml's supported way of changing which schema matches
    // which file, and registers nothing new. A file's kind changes whenever the
    // user corrects one, so this path runs far more often than init does.
    const { initMonacoYaml, setSchemaAssignments } = await freshSetup();
    await initMonacoYaml();

    await setSchemaAssignments({ "model.yaml": "model" }, {});

    expect(update).toHaveBeenCalledTimes(1);
    expect(configureMonacoYaml).toHaveBeenCalledTimes(1);
  });

  it("spends no update restating what init already applied", async () => {
    // Init used to leave `applied` null, so the first assignment always looked
    // like a change even when it was not — and every `update` disposes the
    // diagnostics adapter and revalidates every open model.
    const { initMonacoYaml, setSchemaAssignments } = await freshSetup();
    await setSchemaAssignments({ "model.yaml": "model" }, {});
    await initMonacoYaml();

    await setSchemaAssignments({ "model.yaml": "model" }, {});

    expect(update).not.toHaveBeenCalled();
  });
});
