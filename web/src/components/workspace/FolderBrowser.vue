<script setup lang="ts">
/**
 * A server-side folder browser.
 *
 * A browser cannot open a native folder dialog and cannot hand a server a path —
 * dropping a folder in gives file *contents*, not a location — so the listing is
 * done server-side by `GET /api/browse/`, which returns directory entries only
 * and never file contents.
 *
 * Its own component because two dialogs need it: one picks the model folder and
 * one picks the folder to create a model *in*. A second copy of a folder picker
 * is the same class of duplication as a second copy of an editor form.
 *
 * Folders that already contain a `model.yaml` are marked, so the answer to "is
 * this the one?" is visible before clicking rather than after.
 */
import { computed, onMounted, ref } from "vue";
import StateMessage from "@/components/app/StateMessage.vue";
import TooltipButton from "@/components/app/TooltipButton.vue";
import { ChevronRight, CornerLeftUp, Folder, FolderCheck } from "@lucide/vue";

import client from "@/api/client";
import type { Listing } from "./browse";
import { ICON_STROKE_WIDTH_TIGHT } from "@/lib/icons";

/** The folder currently being shown, once the server has resolved it. */
const listing = defineModel<Listing | null>("listing", { default: null });

const isLoading = ref(false);
const error = ref<string | null>(null);

const entries = computed(() => listing.value?.entries ?? []);

async function browse(path?: string) {
  isLoading.value = true;
  error.value = null;
  try {
    listing.value = (
      await client.get<Listing>("/api/browse/", { params: path ? { path } : {} })
    ).data;
  } catch {
    error.value = "That folder could not be listed.";
  } finally {
    isLoading.value = false;
  }
}

// A dialog's content is unmounted when it closes, so this runs on every open.
// The listing is held by whoever owns the model — which is how reopening lands
// where it was left, and how the new-model dialog inherits the folder the
// open-model dialog was looking at. Only a browser that has never listed
// anything fetches, and `GET /api/browse/` defaults to the home directory.
onMounted(() => {
  if (!listing.value) browse();
});

defineExpose({ browse });
</script>

<template>
  <div class="flex min-h-0 flex-col gap-2">
    <div class="flex h-7 items-center gap-1.5">
      <TooltipButton
        label="Up one level"
        :icon="CornerLeftUp"
        testid="browse-up"
        :disabled="!listing?.parent"
        @click="browse(listing?.parent ?? undefined)"
      />
      <span
        data-testid="browse-path"
        class="min-w-0 flex-1 truncate rounded-sm border border-border bg-surface-2 px-2 py-1 font-mono text-xs"
      >
        {{ listing?.path ?? "…" }}
      </span>
    </div>

    <div
      class="h-72 min-h-0 overflow-y-auto rounded-sm border border-border bg-surface"
      data-testid="browse-entries"
    >
      <StateMessage v-if="isLoading" variant="inline" loading>Listing…</StateMessage>
      <StateMessage v-else-if="error" variant="inline" tone="danger">
        {{ error }}
      </StateMessage>
      <StateMessage v-else-if="!entries.length" variant="inline">
        No folders here.
      </StateMessage>

      <button
        v-for="entry in entries"
        v-else
        :key="entry.path"
        type="button"
        :data-testid="`browse-entry-${entry.name}`"
        :data-model="entry.is_model || undefined"
        class="flex h-6 w-full items-center gap-1.5 px-2 text-left text-sm hover:bg-hover"
        @click="browse(entry.path)"
      >
        <component
          :is="entry.is_model ? FolderCheck : Folder"
          class="size-3.5 shrink-0"
          :class="entry.is_model ? 'text-accent-text' : 'text-text-faint'"
        />
        <span class="min-w-0 flex-1 truncate">{{ entry.name }}</span>
        <span v-if="entry.is_model" class="shrink-0 text-2xs text-accent-text">
          model
        </span>
        <ChevronRight
          class="size-3 shrink-0 text-text-faint"
          :stroke-width="ICON_STROKE_WIDTH_TIGHT"
        />
      </button>

      <p v-if="listing?.truncated" class="p-2 text-2xs text-text-faint">
        Only the first entries are shown.
      </p>
    </div>
  </div>
</template>
