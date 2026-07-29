<script setup lang="ts">
/**
 * A rendered Markdown file.
 *
 * **It reads the buffer, not the file.** Editing in Source and switching back
 * to Preview has to show what was just typed; fetching would show what was last
 * saved, which looks exactly like the toggle being broken. `lib/monacoBuffer.ts`
 * is where the editor's text model is reached from — Monaco's registry is
 * global, so nothing has to be threaded through a store to get at it.
 *
 * The fetch is the fallback for the case where no editor has opened this file
 * yet, which is the normal one: a markdown tab opens in Preview, so the Source
 * pane — and therefore the model — may never have existed.
 *
 * `v-html` is safe here because `renderMarkdown` is configured with
 * `html: false`; see the reasoning in `lib/markdown.ts`. Do not relax that
 * without adding a sanitizer in the same change.
 */
import { computed, onUnmounted, ref, watch } from "vue";

import StateMessage from "@/components/app/StateMessage.vue";
import { getFile } from "@/api/versions";
import { errorDetail } from "@/api/errors";
import { renderMarkdown } from "@/lib/markdown";
import { bufferText, onBufferChange } from "@/lib/monacoBuffer";

const props = defineProps<{ versionId: string; path: string }>();

const source = ref<string | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);

let unsubscribe: (() => void) | null = null;

async function load() {
  error.value = null;
  // The buffer wins where it exists: it is the same file, one or more edits
  // ahead of what is on disk.
  const buffered = bufferText(props.path);
  if (buffered !== null) {
    source.value = buffered;
  } else {
    loading.value = true;
    try {
      source.value = await getFile(props.versionId, props.path);
    } catch (caught) {
      source.value = null;
      error.value = errorDetail(caught, "This file could not be read.");
    } finally {
      loading.value = false;
    }
  }

  unsubscribe?.();
  unsubscribe = onBufferChange(props.path, () => {
    source.value = bufferText(props.path) ?? source.value;
  });
}

watch(() => [props.versionId, props.path], load, { immediate: true });
onUnmounted(() => unsubscribe?.());

const html = computed(() => (source.value === null ? "" : renderMarkdown(source.value)));
</script>

<template>
  <div class="overflow-auto bg-surface">
    <StateMessage v-if="loading" variant="fill" loading>Reading the file…</StateMessage>
    <StateMessage v-else-if="error" variant="fill" tone="danger">
      {{ error }}
    </StateMessage>
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div v-else class="cg-markdown" data-testid="markdown-preview" v-html="html" />
  </div>
</template>
