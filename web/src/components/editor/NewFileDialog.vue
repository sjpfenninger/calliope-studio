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
import { computed, ref, watch } from "vue";

import FieldRow from "@/components/app/FieldRow.vue";
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

watch(open, (isOpen) => {
  if (!isOpen) return;
  name.value = "";
  error.value = null;
});

/**
 * The cursor lands in the name box through Reka's own focus pass rather than a
 * `nextTick` after it — the same shape as `NewModelDialog`, where the pass
 * would otherwise take the first focusable thing a tick after ours.
 */
function focusName(event: Event) {
  event.preventDefault();
  field.value?.focus();
}

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

/**
 * The one line under the field: a server refusal, a reason it cannot be
 * created yet, the path it would make, or a prompt. Four `<p>`s at three sizes
 * and two paddings used to take turns here, so the dialog jumped as you typed.
 */
const status = computed<{ tone: "danger" | "muted"; text: string; testid?: string }>(() => {
  if (error.value) return { tone: "danger", text: error.value };
  if (problem.value) return { tone: "danger", text: problem.value };
  if (target.value) return { tone: "muted", text: target.value, testid: "new-entry-target" };
  return { tone: "muted", text: `Give the ${noun.value} a name.` };
});

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
    <DialogContent :data-testid="`new-${noun}-dialog`" @open-auto-focus="focusName">
      <DialogHeader>
        <DialogTitle>New {{ noun }}</DialogTitle>
        <DialogDescription>
          In <code :class="IDENTIFIER">{{ parent || "the model folder" }}</code
          >. A name may contain “/” to create folders along the way.
        </DialogDescription>
      </DialogHeader>

      <FieldRow label="Name">
        <input
          ref="field"
          v-model="name"
          aria-label="Name"
          :data-testid="`new-${noun}-name`"
          :placeholder="kind === 'file' ? 'techs.yaml' : 'model_config'"
          :class="FIELD"
          @keydown.enter="create"
        />
      </FieldRow>

      <StateMessage variant="note" :tone="status.tone" :data-testid="status.testid">
        {{ status.text }}
      </StateMessage>

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
