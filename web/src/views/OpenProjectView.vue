<script setup lang="ts">
/**
 * Resolves a project to its version, then replaces itself with the shell.
 *
 * A project id alone cannot address the shell — the editor works against a
 * version — and a redirect cannot be asynchronous, so this is a real component
 * that navigates once it knows the answer. `replace`, so the resolver does not
 * sit in the history for the back button to land on.
 */
import { onMounted, ref } from "vue";
import StateMessage from "@/components/app/StateMessage.vue";
import { useRoute, useRouter } from "vue-router";

import { listVersions } from "@/api/projects";

const route = useRoute();
const router = useRouter();
const error = ref<string | null>(null);

onMounted(async () => {
  const projectId = route.params.projectId as string;
  try {
    const versions = await listVersions(projectId);
    if (!versions.length) {
      error.value = "This model has no version to open.";
      return;
    }
    router.replace({
      name: "model",
      params: { projectId, versionId: versions[0].id },
    });
  } catch {
    error.value = "That model could not be opened. It may have been moved.";
  }
});
</script>

<template>
  <StateMessage v-if="error" variant="fill" tone="danger">
    {{ error }}
    <template #action>
      <RouterLink :to="{ name: 'projects' }" class="text-accent-text underline">
        Recent models
      </RouterLink>
    </template>
  </StateMessage>
  <StateMessage v-else variant="fill" loading>Opening…</StateMessage>
</template>
