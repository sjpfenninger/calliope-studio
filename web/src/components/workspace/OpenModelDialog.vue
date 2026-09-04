<script setup lang="ts">
/**
 * Finding a model folder to open.
 *
 * The browsing itself is `FolderBrowser`, shared with the new-model dialog; what
 * is left here is the question this dialog asks — "is this the one?" — and the
 * way out when the answer is "there is nothing here yet", which used to be a
 * dead end telling the user to go and run `calliope new` in a terminal.
 */
import { ref, watch } from "vue";
import StateMessage from "@/components/app/StateMessage.vue";
import {
  IDENTIFIER,
  PRIMARY_BUTTON_MD,
  SECONDARY_BUTTON_MD,
} from "@/lib/formClasses";
import { cn } from "@/lib/utils";
import { FolderPlus } from "@lucide/vue";

import { errorDetail } from "@/api/errors";
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

// Only `DialogContent` unmounts on close, so both refs outlive it. A stale error
// is not merely untidy: it wins the `v-if` chain below, so the dialog reopens
// showing last time's failure *and* with the "Create a model here" way out
// hidden — which is exactly the offer somebody who failed to open a folder wants.
watch(open, (isOpen) => {
  if (!isOpen) return;
  error.value = null;
  opening.value = false;
});

async function openHere() {
  const path = listing.value?.path;
  if (!path || opening.value || !listing.value?.is_model) return;
  opening.value = true;
  try {
    const project = await openProject(path);
    open.value = false;
    emit("opened", project.id);
  } catch (caught) {
    error.value = errorDetail(caught, "That folder could not be opened.");
  } finally {
    opening.value = false;
  }
}

/**
 * Enter submits, as it does in the two dialogs with a text field — but not
 * from a button, where Enter already means that button: a folder row is
 * "go into this folder", and Cancel is Cancel.
 */
function onEnter(event: KeyboardEvent) {
  if ((event.target as HTMLElement | null)?.closest("button")) return;
  void openHere();
}
</script>

<template>
  <Dialog v-model:open="open">
    <!-- `sm:` on purpose: unprefixed, this is the same tailwind-merge group as
         the primitive's small-viewport guard and replaces it. -->
    <DialogContent
      class="sm:max-w-2xl"
      data-testid="open-model-dialog"
      @keydown.enter="onEnter"
    >
      <DialogHeader>
        <DialogTitle>Open a model</DialogTitle>
        <DialogDescription>
          Pick the folder containing your model's
          <code :class="IDENTIFIER">model.yaml</code>.
        </DialogDescription>
      </DialogHeader>

      <FolderBrowser v-model:listing="listing" />

      <StateMessage v-if="error" variant="note" tone="danger">{{ error }}</StateMessage>
      <StateMessage v-else-if="listing && !listing.is_model" variant="note">
        This folder has no <code :class="IDENTIFIER">model.yaml</code>.
        <template #action>
          <button
            type="button"
            data-testid="create-here"
            :class="cn(SECONDARY_BUTTON_MD, 'ml-auto shrink-0')"
            @click="emit('create')"
          >
            <FolderPlus class="size-3.5" />
            Create a model here…
          </button>
        </template>
      </StateMessage>

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
