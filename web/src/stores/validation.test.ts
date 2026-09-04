import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/system", () => ({ cancelTask: vi.fn(), getTask: vi.fn() }));
vi.mock("../api/versions", () => ({ startValidation: vi.fn() }));

import { cancelTask, getTask } from "../api/system";
import { startValidation } from "../api/versions";
import { useValidationStore, type ValidationProblem } from "./validation";

const start = vi.mocked(startValidation);
const task = vi.mocked(getTask);
const kill = vi.mocked(cancelTask);

function problem(overrides: Partial<ValidationProblem> = {}): ValidationProblem {
  return {
    file: "model.yaml",
    line: 12,
    column: 1,
    message: "expected ']'",
    severity: "error",
    tier: "syntax",
    ...overrides,
  };
}

/** The envelope both `/validate/` and `/tasks/{id}/` answer with. */
function envelope(over: Record<string, unknown> = {}) {
  return {
    task_id: null,
    status: "done",
    phase: "syntax",
    result: { errors: [] },
    ...over,
  };
}

/**
 * Validation, and what it must forget when the user opens another model.
 *
 * The store had no notion of *which* model it had validated, and no way to be
 * told. Everything it holds is model-specific — the sidebar badge, the problem
 * rows, and a `jumpTo(file, line)` naming a path that need not exist in the
 * model now open — so all of it went on describing the model just left. The
 * sharpest edge was the guard at the top of `validate`: with the previous
 * model's build still running the phase stayed `build`, so the Validate button
 * did nothing at all on the new model until somebody guessed to press Cancel.
 */
describe("useValidationStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    start.mockReset();
    task.mockReset();
    kill.mockReset();
    kill.mockResolvedValue(undefined);
  });

  afterEach(() => vi.useRealTimers());

  describe("running", () => {
    it("reports what the syntax tier found without starting a build", async () => {
      // A file that will not parse also fails `read_yaml`, so escalating would
      // spend seconds to arrive at a worse message with no line number.
      const store = useValidationStore();
      start.mockResolvedValue(envelope({ result: { errors: [problem()] } }));

      await store.validate("v1");

      expect(store.phase).toBe("done");
      expect(store.problems).toHaveLength(1);
      expect(store.taskId).toBeNull();
      expect(task).not.toHaveBeenCalled();
    });

    it("escalates a clean parse to the build tier and polls it", async () => {
      const store = useValidationStore();
      start.mockResolvedValue(envelope({ task_id: "t1", status: "running" }));
      await store.validate("v1");
      expect(store.phase).toBe("build");
      expect(store.taskId).toBe("t1");

      task.mockResolvedValue(
        envelope({ phase: "build", result: { errors: [problem({ tier: "build" })] } }),
      );
      await vi.advanceTimersByTimeAsync(300);

      expect(store.phase).toBe("done");
      expect(store.problems[0].tier).toBe("build");
    });

    it("stamps the time a validation finished, so the tab can say when", async () => {
      const store = useValidationStore();
      start.mockResolvedValue(envelope());

      expect(store.lastValidatedAt).toBeNull();
      await store.validate("v1");
      expect(store.lastValidatedAt).toEqual(expect.any(Number));
    });

    it("keeps a transport failure apart from a statement about the model", async () => {
      // A 500 is not "your model is invalid", and showing it as a problem row
      // would put a server fault in the list of things to go and fix.
      const store = useValidationStore();
      start.mockRejectedValue(new Error("connection refused"));

      await store.validate("v1");

      expect(store.error).toBe("connection refused");
      expect(store.problems).toEqual([]);
      expect(store.phase).toBe("idle");
    });
  });

  describe("cancel", () => {
    it("leaves no problems, because a cancelled build has no answer", async () => {
      const store = useValidationStore();
      start.mockResolvedValue(envelope({ task_id: "t1", status: "running" }));
      await store.validate("v1");

      await store.cancel();
      // The poll was already scheduled; its reply must not report the killed
      // task's outcome as though anyone had waited for it.
      task.mockResolvedValue(envelope({ result: { errors: [problem()] } }));
      await vi.advanceTimersByTimeAsync(2000);

      expect(store.problems).toEqual([]);
      expect(store.phase).toBe("idle");
      expect(kill).toHaveBeenCalledWith("t1");
    });
  });

  describe("reset", () => {
    it("clears everything the previous model put on screen", async () => {
      const store = useValidationStore();
      start.mockResolvedValue(envelope({ result: { errors: [problem()] } }));
      await store.validate("v1");

      store.reset();

      expect(store.problems).toEqual([]);
      expect(store.phase).toBe("idle");
      expect(store.error).toBeNull();
      expect(store.taskId).toBeNull();
      // The timestamp goes too: "validated 2 minutes ago" is a claim about the
      // model on screen, and after a switch it is a false one.
      expect(store.lastValidatedAt).toBeNull();
    });

    it("kills a build left running by the model being left", async () => {
      const store = useValidationStore();
      start.mockResolvedValue(envelope({ task_id: "t1", status: "running" }));
      await store.validate("v1");

      store.reset();

      expect(kill).toHaveBeenCalledWith("t1");
    });

    it("survives the kill failing, since the task was gone anyway", async () => {
      const store = useValidationStore();
      start.mockResolvedValue(envelope({ task_id: "t1", status: "running" }));
      await store.validate("v1");
      kill.mockRejectedValue(new Error("404"));

      // Fire-and-forget: a rejection here would surface as an unhandled one out
      // of the shell's version watcher, which holds no `catch`.
      expect(() => store.reset()).not.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      expect(store.phase).toBe("idle");
    });

    it("accepts a validate immediately afterwards, even from a build", async () => {
      // This is the whole point. `validate` returns early while the phase is
      // `syntax` or `build`, so without the phase reset the button was dead on
      // the new model for as long as the old model's build kept running.
      const store = useValidationStore();
      start.mockResolvedValue(envelope({ task_id: "t1", status: "running" }));
      await store.validate("v1");
      expect(store.phase).toBe("build");

      store.reset();
      start.mockResolvedValue(envelope({ result: { errors: [problem()] } }));
      await store.validate("v2");

      expect(start).toHaveBeenLastCalledWith("v2");
      expect(store.problems).toHaveLength(1);
    });

    it("stops the previous model's poll from reporting into the new one", async () => {
      const store = useValidationStore();
      start.mockResolvedValue(envelope({ task_id: "t1", status: "running" }));
      await store.validate("v1");

      store.reset();
      task.mockResolvedValue(
        envelope({ result: { errors: [problem({ file: "old-model.yaml" })] } }),
      );
      await vi.advanceTimersByTimeAsync(5000);

      expect(store.problems).toEqual([]);
      expect(store.phase).toBe("idle");
    });

    it("discards a start that was already on the wire", async () => {
      // `reset` happens on the route change, which can easily beat the POST it
      // interrupts; the reply carries the old model's problems.
      const store = useValidationStore();
      let land!: (value: unknown) => void;
      start.mockReturnValue(
        new Promise((resolve) => {
          land = resolve;
        }),
      );
      const pending = store.validate("v1");

      store.reset();
      land(envelope({ result: { errors: [problem()] } }));
      await pending;

      expect(store.problems).toEqual([]);
      expect(store.phase).toBe("idle");
    });
  });

  describe("severity", () => {
    it("counts errors and warnings apart", async () => {
      // `severity` arrived on every problem and was read by nothing: the rows
      // were all painted as errors and the badge was always destructive, so a
      // model that merely warned looked like one that would not build. The two
      // counts are what the tab's row tone and the sidebar's badge variant key on.
      const store = useValidationStore();
      start.mockResolvedValue(
        envelope({
          result: {
            errors: [
              problem(),
              problem({ severity: "warning", tier: "build", line: null }),
              problem({ severity: "warning", tier: "build", line: null }),
            ],
          },
        }),
      );

      await store.validate("v1");

      expect(store.errorCount).toBe(1);
      expect(store.warningCount).toBe(2);
    });

    it("counts nothing once reset", async () => {
      const store = useValidationStore();
      start.mockResolvedValue(envelope({ result: { errors: [problem()] } }));
      await store.validate("v1");
      store.reset();
      expect(store.errorCount).toBe(0);
      expect(store.warningCount).toBe(0);
    });
  });
});
