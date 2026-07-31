<script setup lang="ts">
/**
 * Naming a new file or folder.
 *
 * Adding a file to a model used to mean leaving the app for a terminal — the
 * same gap `POST /api/projects/new/` closed for whole models, one level down.
 *
 * A dialog rather than an inline row in the tree: Reka's `TreeRoot` runs its
 * typeahead on every keydown inside `role="tree"`, which is why `TreeSearch` has
 * to be a *sibling* of the tree, and an input placed within a `TreeItem` would
 * hit exactly that — the selection moving on every letter typed.
 *
 * The shape follows `workspace/NewModelDialog.vue`, which is the app's existing
 * "name a new thing": a name field, a live reason it cannot be created yet, and
 * the resulting path shown before the button is pressed rather than after.
 */
import { computed, nextTick, ref, watch } from "vue";

import StateMessage from "@/components/app/StateMessage.vue";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { createFile, createFolder } from "@/api/versions";
import { errorDetail } from "@/api/errors";
import {
  FIELD,
  IDENTIFIER,
  PRIMARY_BUTTON_MD,
  SECONDARY_BUTTON_MD,
} from "@/lib/formClasses";
import { cn } from "@/lib/utils";

const props = defineProps<{
  versionId: string;
  kind: "file" | "folder";
  /** Workspace-relative folder to create in; `""` is the model root. */
  parent: string;
  /** Every path already in the tree, files and folders alike. */
  taken: Set<string>;
}>();

const open = defineModel<boolean>("open", { default: false });
/**
 * The kind travels with the event rather than being read back off the caller's
 * state. Closing the dialog is what clears that state, and closing happens
 * first — so a handler that looked it up afterwards saw `null` and could not
 * tell a new file from a new folder.
 */
const emit = defineEmits<{ created: [path: string, kind: "file" | "folder"] }>();

const name = ref("");
const error = ref<string | null>(null);
const busy = ref(false);
const field = ref<HTMLInputElement>();

const noun = computed(() => (props.kind === "file" ? "file" : "folder"));

watch(open, async (isOpen) => {
  if (!isOpen) return;
  name.value = "";
  error.value = null;
  await nextTick();
  field.value?.focus();
});

/** The path that would be created, as the server will resolve it. */
const target = computed(() => {
  const typed = name.value.trim().replace(/^\/+|\/+$/g, "");
  if (!typed) return null;
  return props.parent ? `${props.parent}/${typed}` : typed;
});

/**
 * Why this cannot be created yet, if it cannot.
 *
 * The server enforces every one of these — `_check_creatable` in `files.py` —
 * and would answer with a 409 or a 400. This is so the answer arrives while the
 * name is being typed.
 */
const problem = computed(() => {
  const typed = name.value.trim();
  if (!typed) return null;
  if (typed.includes("\\")) return "Use “/” to separate folders.";
  if (typed.split("/").some((part) => part === ".." || part === "."))
    return "A name cannot contain “.” or “..”.";
  if (typed.split("/").some((part) => part.startsWith(".")))
    return "A name starting with a dot would be hidden.";
  if (target.value && props.taken.has(target.value))
    return "There is already something with that name.";
  return null;
});

const canCreate = computed(
  () => Boolean(target.value) && !problem.value && !busy.value,
);

async function create() {
  if (!canCreate.value || !target.value) return;
  busy.value = true;
  error.value = null;
  try {
    if (props.kind === "file") {
      await createFile(props.versionId, target.value);
    } else {
      await createFolder(props.versionId, target.value);
    }
    const created = target.value;
    open.value = false;
    emit("created", created, props.kind);
  } catch (caught) {
    error.value = errorDetail(caught, `That ${noun.value} could not be created.`);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-lg" :data-testid="`new-${noun}-dialog`">
      <DialogHeader>
        <DialogTitle>New {{ noun }}</DialogTitle>
        <DialogDescription>
          In <code :class="IDENTIFIER">{{ parent || "the model folder" }}</code
          >. A name may contain “/” to create folders along the way.
        </DialogDescription>
      </DialogHeader>

      <div class="flex items-center gap-2">
        <label class="shrink-0 text-sm text-text-dim" for="new-entry-name">Name</label>
        <input
          id="new-entry-name"
          ref="field"
          v-model="name"
          :data-testid="`new-${noun}-name`"
          :placeholder="kind === 'file' ? 'techs.yaml' : 'model_config'"
          :class="cn(FIELD, 'flex-1')"
          @keydown.enter="create"
        />
      </div>

      <StateMessage v-if="error" variant="inline" tone="danger">{{ error }}</StateMessage>
      <p v-else-if="problem" class="text-2xs text-danger-text">{{ problem }}</p>
      <p
        v-else-if="target"
        data-testid="new-entry-target"
        class="truncate text-sm text-text-faint"
      >
        {{ target }}
      </p>
      <p v-else class="text-2xs text-text-faint">
        Give the {{ noun }} a name.
      </p>

      <DialogFooter>
        <button type="button" :class="SECONDARY_BUTTON_MD" @click="open = false">
          Cancel
        </button>
        <button
          type="button"
          :data-testid="`create-${noun}`"
          :disabled="!canCreate"
          :class="PRIMARY_BUTTON_MD"
          @click="create"
        >
          Create {{ noun }}
        </button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
