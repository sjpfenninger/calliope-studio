<script setup lang="ts">
/**
 * Finding a model folder to open.
 *
 * A browser cannot open a native folder dialog and cannot hand a server a path —
 * dropping a folder in gives file *contents*, not a location — so the listing is
 * done server-side by `GET /api/browse/`, which returns directory entries only
 * and never file contents. Until this existed, the only way to add a model was
 * to POST an absolute path to a JSON API.
 *
 * Folders that already contain a `model.yaml` are marked, so the answer to "is
 * this the one?" is visible before clicking rather than after.
 */
import { computed, ref, watch } from "vue";
import StateMessage from "@/components/app/StateMessage.vue";
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "@/lib/formClasses";
import { cn } from "@/lib/utils";
import { ChevronRight, CornerLeftUp, Folder, FolderCheck } from "@lucide/vue";

import client from "@/api/client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ICON_STROKE_WIDTH_TIGHT } from "@/lib/icons";

const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ opened: [projectId: string] }>();

interface Entry {
  name: string;
  path: string;
  is_model: boolean;
}

interface Listing {
  path: string;
  parent: string | null;
  is_model: boolean;
  entries: Entry[];
  truncated: boolean;
}

const listing = ref<Listing | null>(null);
const isLoading = ref(false);
const error = ref<string | null>(null);
const opening = ref(false);

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

// Starts at the home directory, which is what `/api/browse/` defaults to and
// where someone looking for their models is most likely to start.
watch(open, (isOpen) => {
  if (isOpen && !listing.value) browse();
});

async function openHere() {
  const path = listing.value?.path;
  if (!path || opening.value) return;
  opening.value = true;
  try {
    const project = (await client.post("/api/projects/", { path })).data;
    open.value = false;
    emit("opened", project.id);
  } catch (caught) {
    const detail = (caught as { response?: { data?: { detail?: string } } }).response
      ?.data?.detail;
    error.value = detail ?? "That folder could not be opened.";
  } finally {
    opening.value = false;
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-w-2xl" data-testid="open-model-dialog">
      <DialogHeader>
        <DialogTitle>Open a model</DialogTitle>
        <DialogDescription>
          Pick the folder containing your model's <code>model.yaml</code>.
        </DialogDescription>
      </DialogHeader>

      <div class="flex h-7 items-center gap-1.5">
        <button
          type="button"
          title="Up one level"
          data-testid="browse-up"
          :disabled="!listing?.parent"
          class="grid size-6 shrink-0 place-items-center rounded-sm text-text-faint hover:bg-hover hover:text-foreground disabled:opacity-40"
          @click="browse(listing?.parent ?? undefined)"
        >
          <CornerLeftUp class="size-3.5" />
        </button>
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
          <ChevronRight class="size-3 shrink-0 text-text-faint" :stroke-width="ICON_STROKE_WIDTH_TIGHT" />
        </button>

        <p v-if="listing?.truncated" class="p-2 text-2xs text-text-faint">
          Only the first entries are shown.
        </p>
      </div>

      <p v-if="error" class="text-sm text-danger-text">{{ error }}</p>
      <p v-else-if="listing && !listing.is_model" class="text-2xs text-text-faint">
        This folder has no <code>model.yaml</code>. Create one here with
        <code class="font-mono">calliope new</code>, or keep looking.
      </p>

      <DialogFooter>
        <button
          type="button"
          :class="cn(SECONDARY_BUTTON, 'h-7 px-3')"
          @click="open = false"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="open-this-folder"
          :disabled="!listing?.is_model || opening"
          :class="cn(PRIMARY_BUTTON, 'h-7 px-3')"
          @click="openHere"
        >
          Open this folder
        </button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
