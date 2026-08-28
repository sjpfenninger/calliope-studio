/**
 * Whether this model is valid, and what is wrong with it.
 *
 * **One action, two tiers.** There were two buttons — "Validate" and "Deep" —
 * which read as two settings of one knob and were nothing of the sort: a
 * millisecond YAML parse, and a full Calliope build taking seconds to minutes.
 * The server now runs the first and escalates to the second only on a clean
 * parse, so there is one call here, one `phase` describing where it has got to,
 * and one list of problems carrying the `tier` that found each.
 *
 * That merge fixed a bug worth remembering: deep results used to be *appended*
 * to whatever was already in the list, so pressing Deep twice showed every
 * problem twice, and the only thing distinguishing the two tiers was a `[deep] `
 * prefix glued onto the message text. The list is cleared once, at the start.
 *
 * A singleton, unlike `stores/runSelection.ts`. A window holds one model and one
 * validation of it; the per-key store factory exists for run tabs, which can be
 * open several at a time, and there is no such thing as two validations.
 */
import { ref } from "vue";
import { defineStore } from "pinia";
import { errorDetail } from "../api/errors";
import { cancelTask, getTask } from "../api/system";
import { startValidation } from "../api/versions";

export type ValidationTier = "syntax" | "build";

/** Where a validation has got to. `idle` also means "never run". */
export type ValidationPhase = "idle" | "syntax" | "build" | "done";

export interface ValidationProblem {
  file: string;
  /** Null for anything the build tier found: Calliope reports no line numbers. */
  line: number | null;
  column: number | null;
  message: string;
  severity: "error" | "warning";
  tier: ValidationTier;
}

interface TaskEnvelope {
  task_id: string | null;
  status: "running" | "done";
  phase: ValidationTier;
  result: { errors: ValidationProblem[] } | null;
}

/**
 * How long to wait before asking again.
 *
 * The old poll waited a flat two seconds before its *first* request, so even a
 * model that finished instantly took two seconds to say so. A build can take
 * minutes, though, so the interval cannot stay at 250ms either.
 */
const POLL_START_MS = 250;
const POLL_MAX_MS = 2000;
const POLL_GROWTH = 1.6;

export const useValidationStore = defineStore("validation", () => {
  const problems = ref<ValidationProblem[]>([]);
  const phase = ref<ValidationPhase>("idle");
  const lastValidatedAt = ref<number | null>(null);
  /** A transport failure, which is not a statement about the model. */
  const error = ref<string | null>(null);

  /** Non-null only while a build is in flight; what `cancel` acts on. */
  const taskId = ref<string | null>(null);

  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Bumped on every start and cancel, so a reply already in flight when the
   * user restarts cannot land in the new run's results.
   */
  let generation = 0;

  function stopPolling() {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function finish(found: ValidationProblem[]) {
    problems.value = found;
    phase.value = "done";
    lastValidatedAt.value = Date.now();
    taskId.value = null;
  }

  async function validate(versionId: string): Promise<void> {
    if (phase.value === "syntax" || phase.value === "build") return;

    const mine = ++generation;
    stopPolling();
    problems.value = [];
    error.value = null;
    taskId.value = null;
    phase.value = "syntax";

    try {
      const envelope = await startValidation<TaskEnvelope>(versionId);
      if (mine !== generation) return;

      if (envelope.status === "done" || !envelope.task_id) {
        finish(envelope.result?.errors ?? []);
        return;
      }

      taskId.value = envelope.task_id;
      phase.value = "build";
      poll(envelope.task_id, mine, POLL_START_MS);
    } catch (err) {
      if (mine !== generation) return;
      error.value = messageFor(err);
      phase.value = "idle";
      taskId.value = null;
    }
  }

  function poll(id: string, mine: number, delay: number) {
    pollTimer = setTimeout(async () => {
      if (mine !== generation) return;
      try {
        const res = { data: await getTask<TaskEnvelope>(id) };
        if (mine !== generation) return;

        if (res.data.status === "done") {
          finish(res.data.result?.errors ?? []);
          return;
        }
        poll(id, mine, Math.min(delay * POLL_GROWTH, POLL_MAX_MS));
      } catch (err) {
        if (mine !== generation) return;
        error.value = messageFor(err);
        phase.value = "idle";
        taskId.value = null;
      }
    }, delay);
  }

  /**
   * Stops an in-flight build.
   *
   * The generation is bumped first so that a poll already on the wire cannot
   * report the killed task's outcome as a result. Nothing is recorded: a
   * cancelled validation has no answer, which is not the same as a clean one.
   */
  async function cancel(): Promise<void> {
    const id = taskId.value;
    generation += 1;
    stopPolling();
    phase.value = "idle";
    taskId.value = null;
    if (!id) return;
    try {
      await cancelTask(id);
    } catch {
      // The task was already gone, which is the state we wanted anyway.
    }
  }

  return {
    problems,
    phase,
    lastValidatedAt,
    error,
    taskId,
    validate,
    cancel,
  };
});

function messageFor(err: unknown): string {
  return errorDetail(err, "Validation could not be run.");
}
