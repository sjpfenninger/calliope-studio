<script setup lang="ts">
/**
 * Finding a model folder to open.
 *
 * The browsing itself is `FolderBrowser`, shared with the new-model dialog; what
 * is left here is the question this dialog asks — "is this the one?" — and the
 * way out when the answer is "there is nothing here yet", which used to be a
 * dead end telling the user to go and run `calliope new` in a terminal.
 */
import { ref } from "vue";
import StateMessage from "@/components/app/StateMessage.vue";
import {
  IDENTIFIER,
  PRIMARY_BUTTON_MD,
  SECONDARY_BUTTON,
  SECONDARY_BUTTON_MD,
} from "@/lib/formClasses";
import { cn } from "@/lib/utils";
import { FolderPlus } from "@lucide/vue";

import { openProject } from "@/api/projects";
import FolderBrowser from "./FolderBrowser.vue";
import type { Listing } from "./browse";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const open = defineModel<boolean>("open", { default: false });
/** Kept by the host, so reopening the dialog lands where it was left. */
const listing = defineModel<Listing | null>("listing", { default: null });

const emit = defineEmits<{
  opened: [projectId: string];
  /** "There is no model here" — offer to create one in this folder instead. */
  create: [];
}>();

const error = ref<string | null>(null);
const opening = ref(false);

async function openHere() {
  const path = listing.value?.path;
  if (!path || opening.value) return;
  opening.value = true;
  try {
    const project = await openProject(path);
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
          Pick the folder containing your model's
          <code :class="IDENTIFIER">model.yaml</code>.
        </DialogDescription>
      </DialogHeader>

      <FolderBrowser v-model:listing="listing" />

      <StateMessage v-if="error" variant="inline" tone="danger">{{ error }}</StateMessage>
      <div v-else-if="listing && !listing.is_model" class="flex items-center gap-2">
        <p class="min-w-0 flex-1 text-2xs text-text-faint">
          This folder has no <code :class="IDENTIFIER">model.yaml</code>.
        </p>
        <button
          type="button"
          data-testid="create-here"
          :class="cn(SECONDARY_BUTTON, 'shrink-0')"
          @click="emit('create')"
        >
          <FolderPlus class="size-3.5" />
          Create a model here…
        </button>
      </div>

      <DialogFooter>
        <button
          type="button"
          :class="SECONDARY_BUTTON_MD"
          @click="open = false"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="open-this-folder"
          :disabled="!listing?.is_model || opening"
          :class="PRIMARY_BUTTON_MD"
          @click="openHere"
        >
          Open this folder
        </button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
