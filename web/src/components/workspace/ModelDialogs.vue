<script setup lang="ts">
/**
 * The two ways to get a model, hosted together.
 *
 * Both the sidebar switcher and the Recent models page offer "Open model" and
 * "New model", and the two dialogs hand off to each other: browsing to a folder
 * with no `model.yaml` used to be a dead end, and now offers to create one
 * there. Wiring that in each call site would be two copies of the same handoff.
 *
 * The browsed listing lives here rather than inside either dialog, because a
 * dialog's content is unmounted when it closes — keeping it at this level is
 * what makes the browser reopen where it was left, in *either* dialog.
 */
import { ref } from "vue";

import NewModelDialog from "./NewModelDialog.vue";
import OpenModelDialog from "./OpenModelDialog.vue";
import type { Listing } from "./browse";

const open = defineModel<"open" | "new" | null>("open", { default: null });

const emit = defineEmits<{ opened: [projectId: string] }>();

const listing = ref<Listing | null>(null);

function isOpen(which: "open" | "new") {
  return open.value === which;
}

function setOpen(which: "open" | "new", value: boolean) {
  if (value) open.value = which;
  else if (open.value === which) open.value = null;
}

// No path is passed across: the shared listing is already showing that folder,
// so the new-model dialog opens exactly where the open-model dialog left off.
function createHere() {
  open.value = "new";
}

function opened(projectId: string) {
  open.value = null;
  emit("opened", projectId);
}
</script>

<template>
  <OpenModelDialog
    :open="isOpen('open')"
    v-model:listing="listing"
    @update:open="(value) => setOpen('open', value)"
    @create="createHere"
    @opened="opened"
  />
  <NewModelDialog
    :open="isOpen('new')"
    v-model:listing="listing"
    @update:open="(value) => setOpen('new', value)"
    @opened="opened"
  />
</template>
