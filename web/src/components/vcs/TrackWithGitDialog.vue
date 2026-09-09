<script setup lang="ts">
/**
 * Putting the model under version control — offered, never imposed.
 *
 * A `.git` directory is metadata in somebody's folder, so nothing is
 * initialised as a side effect of opening a model; the user asks, and the
 * dialog shows exactly what will be written before anything is. The ignore
 * file comes from the server so that what is promised and what is written
 * are one string.
 */
import { computed, ref, watch } from "vue";

import StateMessage from "@/components/app/StateMessage.vue";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { errorDetail } from "@/api/errors";
import { CODE_BLOCK, CODE_WELL, IDENTIFIER, PRIMARY_BUTTON_MD, SECONDARY_BUTTON_MD } from "@/lib/formClasses";
import { formatCount } from "@/lib/format";
import { useVcsStore } from "@/stores/vcs";

const props = defineProps<{ fileCount: number }>();

const open = defineModel<boolean>("open", { default: false });

const vcs = useVcsStore();

const error = ref<string | null>(null);

watch(open, (isOpen) => {
  if (isOpen) error.value = null;
});

/** The ignored-inside-a-repository case gets its own explanation. */
const ignoredBy = computed(() => (vcs.state === "ignored" ? vcs.status?.root : null));

async function track() {
  error.value = null;
  try {
    await vcs.init();
    open.value = false;
  } catch (caught) {
    error.value = errorDetail(caught, "The repository could not be created.");
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent data-testid="vcs-track-dialog">
      <DialogHeader>
        <DialogTitle>Track this model with git</DialogTitle>
        <DialogDescription>
          <template v-if="ignoredBy">
            This folder is inside the repository at
            <code :class="IDENTIFIER">{{ ignoredBy }}</code>, which ignores it. A separate
            repository will be created here, in this folder alone.
          </template>
          <template v-else>
            A repository is created in the model folder and
            {{ formatCount(props.fileCount, "file") }} committed as they are now.
          </template>
        </DialogDescription>
      </DialogHeader>

      <div v-if="vcs.status?.gitignore" class="flex flex-col gap-1">
        <p class="text-sm text-text-dim">
          This <code :class="IDENTIFIER">.gitignore</code> is written first, so solved
          models are never committed:
        </p>
        <pre :class="[CODE_BLOCK, CODE_WELL]" data-testid="vcs-track-gitignore">{{ vcs.status.gitignore }}</pre>
      </div>
      <p v-else class="text-sm text-text-dim">
        The folder's own <code :class="IDENTIFIER">.gitignore</code> is kept.
      </p>

      <StateMessage v-if="error" variant="note" tone="danger">{{ error }}</StateMessage>

      <DialogFooter>
        <button type="button" :class="SECONDARY_BUTTON_MD" @click="open = false">
          Cancel
        </button>
        <button
          type="button"
          data-testid="vcs-track-confirm"
          :class="PRIMARY_BUTTON_MD"
          :disabled="vcs.busy"
          @click="track"
        >
          Track with git
        </button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
