<script setup lang="ts">
/**
 * Resolves a set of results to a run tab, then replaces itself with the shell.
 *
 * Serves three entry points: `/results`, `/results/:runId` and `/runs/:runId`.
 * The first is how `calligraph results.nc` lands straight on the charts, and the
 * other two are what an old bookmark looks like.
 *
 * Three ways to find something to open, in order of how specific they are:
 *
 *   1. a run id in the URL;
 *   2. the results file the server itself was opened on;
 *   3. the newest run in the active workspace that produced results.
 *
 * The health payload now states its mode outright, so this no longer has to
 * infer "we are looking at a bare results file" from a null workspace id — which
 * conflated that with "a folder containing no model".
 */
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import client from "@/api/client";
import { runTabId } from "@/lib/tabId";

const route = useRoute();
const router = useRouter();
const error = ref<string | null>(null);

interface Health {
  mode: "workspace" | "results" | "unknown";
  workspace_id: string | null;
  results_handle: string | null;
  run_id: string | null;
}

interface RunRecord {
  id: string;
  results_handle: string | null;
  workspace?: string | null;
}

onMounted(async () => {
  const runId = (route.params.runId as string) ?? null;

  try {
    const health = (await client.get<Health>("/api/health")).data;

    if (runId) {
      const run = (await client.get<RunRecord>(`/api/runs/${runId}/`)).data;
      return openIn(health, runTabId(run.id, run.results_handle));
    }

    if (health.results_handle) {
      // The server was started on a `.nc`. It may still belong to a run, in
      // which case health says so and the whole workspace is available.
      return openIn(health, runTabId(health.run_id, health.results_handle));
    }

    if (health.workspace_id) {
      const runs = (
        await client.get<RunRecord[]>(`/api/versions/${health.workspace_id}/runs/`)
      ).data;
      const newest = runs.find((run) => run.results_handle);
      if (newest) {
        return openIn(health, runTabId(newest.id, newest.results_handle));
      }
      // Nothing has been solved yet, so send them where they can solve.
      return router.replace({
        name: "runs",
        params: { projectId: health.workspace_id, versionId: health.workspace_id },
      });
    }

    error.value = "There are no results to open.";
  } catch {
    error.value = "Those results could not be opened.";
  }
});

function openIn(health: Health, tab: string) {
  // With a workspace, the run opens inside the full shell; without one, in the
  // cut-down viewer where Model and Files are unavailable.
  router.replace(
    health.workspace_id
      ? {
          name: "runs",
          params: {
            projectId: health.workspace_id,
            versionId: health.workspace_id,
          },
          query: { tab },
        }
      : { name: "viewer", query: { tab } },
  );
}
</script>

<template>
  <div class="grid flex-1 place-items-center text-sm text-muted-foreground">
    <p v-if="error">
      {{ error }}
      <RouterLink :to="{ name: 'projects' }" class="text-accent-text underline">
        Recent models
      </RouterLink>
    </p>
    <p v-else>Opening results…</p>
  </div>
</template>
