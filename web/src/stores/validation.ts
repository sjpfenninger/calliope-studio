import { ref } from "vue";
import { defineStore } from "pinia";
import client from "../api/client";

export interface ValidationError {
  file: string;
  line: number | null;
  column: number | null;
  message: string;
  severity: "error" | "warning";
}

export const useValidationStore = defineStore("validation", () => {
  const errors = ref<ValidationError[]>([]);
  const isValidating = ref(false);
  const isDeepValidating = ref(false);

  let deepPollTimer: ReturnType<typeof setTimeout> | null = null;

  async function validate(versionId: string): Promise<void> {
    isValidating.value = true;
    errors.value = [];
    try {
      const res = await client.post<{ errors: ValidationError[] }>(
        `/api/versions/${versionId}/validate/`
      );
      errors.value = res.data.errors;
    } finally {
      isValidating.value = false;
    }
  }

  async function validateDeep(versionId: string): Promise<void> {
    if (isDeepValidating.value) return;
    isDeepValidating.value = true;

    if (deepPollTimer !== null) {
      clearTimeout(deepPollTimer);
      deepPollTimer = null;
    }

    try {
      const res = await client.post<{ task_id: string }>(
        `/api/versions/${versionId}/validate/deep/`
      );
      const taskId = res.data.task_id;
      _pollDeep(taskId);
    } catch {
      isDeepValidating.value = false;
    }
  }

  function _pollDeep(taskId: string) {
    deepPollTimer = setTimeout(async () => {
      try {
        const res = await client.get<{
          status: string;
          result: { errors: ValidationError[] } | null;
        }>(`/api/tasks/${taskId}/`);
        const { status, result } = res.data;
        if (status === "done" || status === "failed") {
          isDeepValidating.value = false;
          if (result?.errors?.length) {
            // Append deep errors, marking their source
            const deep = result.errors.map((e) => ({ ...e, message: `[deep] ${e.message}` }));
            errors.value = [...errors.value, ...deep];
          }
        } else {
          _pollDeep(taskId);
        }
      } catch {
        isDeepValidating.value = false;
      }
    }, 2000);
  }

  return { errors, isValidating, isDeepValidating, validate, validateDeep };
});
