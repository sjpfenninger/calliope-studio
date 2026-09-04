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
import PanelHeader from "@/components/app/PanelHeader.vue";
import StateMessage from "@/components/app/StateMessage.vue";
import TooltipButton from "@/components/app/TooltipButton.vue";
import { Badge } from "@/components/ui/badge";
import { ChevronRight, CornerLeftUp, Folder, FolderCheck } from "@lucide/vue";

import { errorDetail } from "@/api/errors";
import { browse as fetchFolder } from "@/api/system";
import type { Listing } from "./browse";
import { ACCENT_BADGE } from "@/lib/formClasses";
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
    listing.value = (await fetchFolder(path)) as Listing;
  } catch (caught) {
    error.value = errorDetail(caught, "That folder could not be listed.");
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
    <PanelHeader tone="card" size="lg">
      <TooltipButton
        label="Up one level"
        :icon="CornerLeftUp"
        testid="browse-up"
        :disabled="!listing?.parent"
        @click="browse(listing?.parent ?? undefined)"
      />
      <!-- A readout at a field's geometry, on the field's surface: it was on
           `surface-2` above a `surface` list, which put the one thing that is
           not a control a step *forward* of the things that are. -->
      <span
        data-testid="browse-path"
        class="flex h-6 min-w-0 flex-1 items-center rounded-sm border border-border bg-surface px-1.5 text-sm"
      >
        <span class="truncate">{{ listing?.path ?? "…" }}</span>
      </span>
    </PanelHeader>

    <!-- design-check: allow height — a scroll viewport, not a control. Fixed so
         the dialog does not resize as the user walks into deeper folders. -->
    <div
      class="h-72 min-h-0 overflow-y-auto rounded-md border border-border bg-surface"
      data-testid="browse-entries"
    >
      <StateMessage v-if="isLoading" variant="inline" loading>Listing folders…</StateMessage>
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
        class="flex h-6 w-full items-center gap-1.5 rounded-sm px-2 text-left text-sm hover:bg-hover"
        @click="browse(entry.path)"
      >
        <component
          :is="entry.is_model ? FolderCheck : Folder"
          class="size-3.5 shrink-0"
          :class="entry.is_model ? 'text-accent-text' : 'text-text-faint'"
        />
        <span class="min-w-0 flex-1 truncate">{{ entry.name }}</span>
        <Badge v-if="entry.is_model" variant="outline" :class="ACCENT_BADGE">model</Badge>
        <ChevronRight
          class="size-3 shrink-0 text-text-faint"
          :stroke-width="ICON_STROKE_WIDTH_TIGHT"
        />
      </button>

      <StateMessage v-if="listing?.truncated" variant="note" class="p-2">
        Only the first entries are shown.
      </StateMessage>
    </div>
  </div>
</template>
