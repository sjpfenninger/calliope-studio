<script setup lang="ts">
/**
 * Starting a model from one of Calliope's built-in examples.
 *
 * This is `calliope new`, which until now was the one step of the loop that had
 * to happen outside the app: define → validate → run → analyse began with a
 * terminal. The server does the copy in process (`modeldef/scaffold.py`), then
 * registers the result, so creating a model and opening it are one action.
 *
 * `calliope new` requires its target not to exist, so the dialog picks a
 * *parent* folder and a name, shows the path those two make, and says so before
 * the request rather than after it.
 */
import { computed, ref, watch } from "vue";
import FieldRow from "@/components/app/FieldRow.vue";
import StateMessage from "@/components/app/StateMessage.vue";
import {
  FIELD,
  FIELD_WIDTH,
  IDENTIFIER,
  PRIMARY_BUTTON_MD,
  SECONDARY_BUTTON_MD,
} from "@/lib/formClasses";

import { errorDetail } from "@/api/errors";
import { createProject } from "@/api/projects";
import { getModelTemplates } from "@/api/system";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const open = defineModel<boolean>("open", { default: false });
/** Kept by the host, so reopening the dialog lands where it was left. */
const listing = defineModel<Listing | null>("listing", { default: null });

const emit = defineEmits<{ opened: [projectId: string] }>();

const name = ref("");
const template = ref("national_scale");
const templates = ref<string[]>([]);
const error = ref<string | null>(null);
const creating = ref(false);
const field = ref<HTMLInputElement>();

watch(open, async (isOpen) => {
  if (!isOpen) return;
  // The name goes with the error: a folder name typed and then abandoned is one
  // the user decided against, and it would otherwise be sitting in the box —
  // pointed at whatever folder the browser happens to be showing this time.
  error.value = null;
  name.value = "";
  if (templates.value.length) return;
  try {
    const body = await getModelTemplates();
    templates.value = body.templates;
    if (body.templates.includes(body.default)) template.value = body.default;
  } catch (caught) {
    error.value = errorDetail(caught, "The list of templates could not be read.");
  }
});

/** The folder that would be created, as the server will resolve it. */
const target = computed(() => {
  const parent = listing.value?.path;
  const folder = name.value.trim();
  if (!parent || !folder) return null;
  return `${parent.replace(/\/$/, "")}/${folder}`;
});

/**
 * Why this cannot be created yet, if it cannot.
 *
 * The server checks all of this too — this is so the answer arrives while the
 * name is being typed rather than after pressing a button.
 */
const problem = computed(() => {
  const folder = name.value.trim();
  if (!folder) return null;
  if (/[/\\]/.test(folder)) return "A name cannot contain a path separator.";
  if (folder.startsWith(".")) return "A name starting with a dot would be hidden.";
  if (listing.value?.entries.some((entry) => entry.name === folder))
    return "There is already something with that name here.";
  return null;
});

/**
 * The one line under the form, whichever of four things it has to say.
 *
 * Four mutually exclusive elements at three sizes and two tones made the dialog
 * jump as the user typed; one message in one place holds still.
 */
const note = computed<{ tone: "danger" | "muted"; text: string | null }>(() => {
  if (error.value) return { tone: "danger", text: error.value };
  if (problem.value) return { tone: "danger", text: problem.value };
  if (target.value) return { tone: "muted", text: null };
  return { tone: "muted", text: "Browse to where the model should go, then give it a name." };
});

const canCreate = computed(() => Boolean(target.value) && !problem.value && !creating.value);

/**
 * The cursor lands in the name box, as it does in `NewFileDialog`: the folder
 * is usually already right, so typing is the first thing to do. Through Reka's
 * own focus pass rather than a `nextTick` after it, because that pass would
 * otherwise take the first focusable thing in the content — the folder
 * browser's Up button — a tick after ours.
 */
function focusName(event: Event) {
  event.preventDefault();
  field.value?.focus();
}

async function create() {
  if (!canCreate.value || !listing.value) return;
  creating.value = true;
  error.value = null;
  try {
    const project = await createProject({
      parent: listing.value.path,
      name: name.value.trim(),
      template: template.value,
    });
    open.value = false;
    name.value = "";
    emit("opened", project.id);
  } catch (caught) {
    error.value = errorDetail(caught, "That model could not be created.");
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <!-- `sm:` on purpose: unprefixed, this is the same tailwind-merge group as
         the primitive's small-viewport guard and replaces it. -->
    <DialogContent
      class="sm:max-w-2xl"
      data-testid="new-model-dialog"
      @open-auto-focus="focusName"
    >
      <DialogHeader>
        <DialogTitle>New model</DialogTitle>
        <DialogDescription>
          Copies one of Calliope's example models — the same thing
          <code :class="IDENTIFIER">calliope new</code> does — and opens it.
        </DialogDescription>
      </DialogHeader>

      <FolderBrowser v-model:listing="listing" />

      <div class="flex flex-col gap-1.5">
        <FieldRow label="Name">
          <input
            ref="field"
            v-model="name"
            data-testid="new-model-name"
            placeholder="my-model"
            aria-label="Name of the new model"
            :class="FIELD"
            @keydown.enter="create"
          />
        </FieldRow>
        <FieldRow label="Template">
          <Select v-model="template">
            <SelectTrigger
              size="sm"
              :class="FIELD_WIDTH.short"
              data-testid="new-model-template"
            >
              <SelectValue placeholder="Template" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="option in templates" :key="option" :value="option">
                {{ option }}
              </SelectItem>
            </SelectContent>
          </Select>
        </FieldRow>
      </div>

      <StateMessage variant="note" :tone="note.tone">
        <template v-if="note.text">{{ note.text }}</template>
        <span v-else data-testid="new-model-target" class="truncate">{{ target }}</span>
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
          data-testid="create-model"
          :disabled="!canCreate"
          :class="PRIMARY_BUTTON_MD"
          @click="create"
        >
          Create model
        </button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
