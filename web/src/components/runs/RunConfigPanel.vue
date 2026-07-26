<script setup lang="ts">
/**
 * The model definition this run was solved from.
 *
 * A stub until the next step, which gives it the frozen file tree and the
 * as-solved summary. It exists now so the sub-view is real rather than
 * conditionally absent — a tab whose tabs appear and disappear as the feature
 * lands is worse than one that says what is coming.
 */
import { onMounted, ref } from "vue";

import client from "@/api/client";

const props = defineProps<{ runId: string; handle: string | null }>();

interface Manifest {
  available: boolean;
  reason: string | null;
  complete?: boolean;
  files?: Array<{ path: string }>;
  external?: Array<{ path: string; reason: string }>;
}

const manifest = ref<Manifest | null>(null);

onMounted(async () => {
  const response = await client.get<Manifest>(`/api/runs/${props.runId}/snapshot/`);
  manifest.value = response.data;
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-auto p-3 text-sm">
    <p v-if="manifest && !manifest.available" class="text-muted-foreground">
      {{ manifest.reason }}
    </p>
    <template v-else-if="manifest">
      <p class="text-muted-foreground">
        {{ manifest.files?.length ?? 0 }} files were frozen when this run started.
      </p>
      <p v-if="manifest.complete === false" class="mt-1 text-warning-text">
        The model refers to files outside its own folder, so the frozen copy is
        not the whole definition.
      </p>
    </template>
  </div>
</template>
