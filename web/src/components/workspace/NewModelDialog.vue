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
import StateMessage from "@/components/app/StateMessage.vue";
import { FIELD, PRIMARY_BUTTON_MD, SECONDARY_BUTTON_MD } from "@/lib/formClasses";
import { cn } from "@/lib/utils";

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

watch(open, async (isOpen) => {
  if (!isOpen) return;
  error.value = null;
  if (templates.value.length) return;
  try {
    const body = await getModelTemplates();
    templates.value = body.templates;
    if (body.templates.includes(body.default)) template.value = body.default;
  } catch {
    error.value = "The list of templates could not be read.";
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

const canCreate = computed(() => Boolean(target.value) && !problem.value && !creating.value);

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
    const detail = (caught as { response?: { data?: { detail?: string } } }).response
      ?.data?.detail;
    error.value = detail ?? "That model could not be created.";
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-w-2xl" data-testid="new-model-dialog">
      <DialogHeader>
        <DialogTitle>New model</DialogTitle>
        <DialogDescription>
          Copies one of Calliope's example models — the same thing
          <code>calliope new</code> does — and opens it.
        </DialogDescription>
      </DialogHeader>

      <FolderBrowser v-model:listing="listing" />

      <div class="flex items-center gap-2">
        <label class="shrink-0 text-sm text-text-dim" for="new-model-name">Name</label>
        <input
          id="new-model-name"
          v-model="name"
          data-testid="new-model-name"
          placeholder="my-model"
          :class="cn(FIELD, 'flex-1')"
          @keydown.enter="create"
        />
        <label class="shrink-0 text-sm text-text-dim">Template</label>
        <Select v-model="template">
          <SelectTrigger size="sm" class="w-36" data-testid="new-model-template">
            <SelectValue placeholder="Template" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="option in templates" :key="option" :value="option">
              {{ option }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <StateMessage v-if="error" variant="inline" tone="danger">{{ error }}</StateMessage>
      <p v-else-if="problem" class="text-2xs text-danger-text">{{ problem }}</p>
      <p v-else-if="target" data-testid="new-model-target" class="truncate font-mono text-xs text-text-faint">
        {{ target }}
      </p>
      <p v-else class="text-2xs text-text-faint">
        Browse to where the model should go, then give it a name.
      </p>

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
