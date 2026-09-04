<script setup lang="ts">
/**
 * TechsEditor — accordion-per-tech editor for the `techs:` YAML section.
 *
 * Supports three modes via props:
 *   - Section tab (entryName=null): shows all techs in the file
 *   - Entry tab (entryName="csp"): shows only the named tech
 *   - File structured view (tabId=filePath, entryName=null): shows all techs
 *
 * Transmission technologies are excluded: they are edited by LinksEditor, which
 * promotes the two nodes they join. They still share this YAML section, so a
 * save writes them back untouched rather than dropping them.
 */
import { ref, computed } from "vue";
import LockedBanner from "@/components/app/LockedBanner.vue";
import StateMessage from "@/components/app/StateMessage.vue";
import FieldRow from "@/components/app/FieldRow.vue";
import { Plus } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { getDataTableParams } from "@/api/versions";
import { useSectionEditor } from "@/composables/useSectionEditor";
import EditorToolbar from "./EditorToolbar.vue";
import ParamRows from "./ParamRows.vue";
import { Accordion } from "@/components/ui/accordion";
import EntryAccordionRow from "./EntryAccordionRow.vue";
import { Switch } from "@/components/ui/switch";
import { ACCENT_BADGE, FIELD, GHOST_BUTTON } from "@/lib/formClasses";
import { formatCount } from "@/lib/format";
import { useFocusNew } from "./focusNew";

import { type DataTableParam } from "@/lib/dataTableParams";
import { collectInherited, techSetsKey } from "@/lib/inherited";
import { useComponentTreeStore } from "@/stores/componentTree";
import { useTemplatesStore } from "@/stores/templates";
import { mergeIntoSection, ownedNames, type RawTech } from "@/lib/techs";
import {
  rawToTech,
  duplicateNameError,
  duplicateNames,
  rememberName,
  renamesFor,
  rowKey,
  techToRaw,
  type TechEntry,
} from "@/lib/entries";
import { usePinnedEntry } from "@/composables/usePinnedEntry";

const props = defineProps<{
  versionId: string;
  filePath: string;
  tabId: string;
  entryName?: string | null;
}>();

const componentTreeStore = useComponentTreeStore();
const templatesStore = useTemplatesStore();

const BASE_TECH_OPTIONS = ["supply", "demand", "storage", "transmission", "conversion"];
/**
 * Reka refuses an item whose value is `""`, since that is what it uses to mean
 * "nothing chosen". The blank row is a real answer here — `base_tech` usually
 * comes from the template, and unsetting it is how you stop overriding that —
 * so it needs a value of its own.
 */
const NONE = "__none__";

const entries = ref<TechEntry[]>([]);
/**
 * Which rows are expanded, by `rowKey`.
 *
 * A `v-model` rather than Reka's `:default-value`, which is read once: with the
 * rows keyed by identity a re-render no longer resets them, so the open set has
 * to be state somebody owns. It is also what lets `addEntry` open the row it
 * just made — a new technology used to arrive collapsed and called `(unnamed)`,
 * which is the one row whose fields are certainly wanted.
 */
const openRows = ref<string[]>([]);

/** The name field of a row just added takes the cursor; see `focusNew`. */
const focus = useFocusNew();
// The section as loaded, so the transmission entries LinksEditor owns survive a
// save from here.
const originalSection = ref<Record<string, RawTech>>({});
// Map from template name → its raw fields (merged from all files that define templates)
const templatesData = computed(() => templatesStore.templates);

// Map from tech name → param name → data-table info
const dataTableParams = ref<Record<string, Record<string, DataTableParam>>>({});

// On an entry tab, the one entry — by identity, so renaming it keeps it.
const { visible: visibleEntries } = usePinnedEntry(entries, () => props.entryName);

/**
 * The model's templates, resolved.
 *
 * From the store rather than merged out of each file's raw `templates:` section:
 * that only ever resolved one hop, so a template inheriting a template showed half
 * of what an entry inherits — and made this editor's own idea of what a
 * transmission tech is disagree with Calliope's.
 */
async function loadTemplatesSection() {
  await templatesStore.load(props.versionId);
}

async function loadDataTableParams() {
  try {
    dataTableParams.value = await getDataTableParams(props.versionId, "tech");
  } catch {
    dataTableParams.value = {};
  }
}

/** Keys the form has a field for, so they get no ghost parameter row. */
const PROMOTED = ["template", "active", "base_tech"];

/**
 * Fixed when the section loads; see `ownedNames`. Extended by a save, because an
 * entry this editor just wrote is one it owns whatever its `base_tech` now says.
 */
const owned = ref<Set<string>>(new Set());

function ownedHere(name: string): boolean {
  return owned.value.has(name);
}

function buildPayload(): Record<string, RawTech> {
  const repeated = duplicateNames(entries.value);
  if (repeated.length) throw duplicateNameError(repeated, "technologies");
  const edited: Record<string, RawTech> = {};
  for (const e of entries.value) {
    if (e.name) edited[e.name] = techToRaw(e);
  }
  // Transmission entries belong to LinksEditor; writing only what is shown here
  // would delete every link in the file.
  return mergeIntoSection(originalSection.value, edited, ownedHere, renamesFor(entries.value));
}

const {
  isLoading,
  isSaving,
  error,
  saveError,
  conflict,
  locked,
  lockOwner,
  save,
  reload,
  markDirty,
} = useSectionEditor({
  versionId: () => props.versionId,
  filePath: () => props.filePath,
  tabId: () => props.tabId,
  section: "techs",
  label: "technologies",
  async apply(data) {
    // Templates first: whether a technology is a transmission link usually comes
    // from its template, so nothing can be classified without them.
    await loadTemplatesSection();
    originalSection.value = data as Record<string, RawTech>;
    owned.value = ownedNames(originalSection.value, templatesData.value, "techs");
    entries.value = Object.entries(originalSection.value)
      .filter(([name]) => owned.value.has(name))
      .map(([name, raw]) => rawToTech(name, raw));
    for (const entry of entries.value) rememberName(entry, entry.name);
    openRows.value = entries.value.map(rowKey);
    await loadDataTableParams();
    // The provenance marker on each field links to the template or table that
    // supplies the value, and the tree is what says which file holds it.
    await componentTreeStore.load(props.versionId);
  },
  build: buildPayload,
  renames: () => renamesFor(entries.value),
  async after(written) {
    // The merged whole becomes the new baseline, or the next save would compute
    // its merge against the section as it was two saves ago.
    if (written) {
      originalSection.value = written as Record<string, RawTech>;
      // Everything on screen is ours, including a row whose `base_tech` the
      // user just set to `transmission`. It moves to LinksEditor on a reload,
      // not underneath the person still editing it. And the file now says each
      // row's current name, so that is what a later rename is measured from.
      for (const entry of entries.value) {
        if (!entry.name) continue;
        owned.value.add(entry.name);
        rememberName(entry, entry.name);
      }
    }
    // A tech added, removed or renamed changes the explorer, as it does for
    // nodes and links.
    await componentTreeStore.refresh(props.versionId);
    // Editing a tech can change what a template means for its siblings.
    await templatesStore.refresh(props.versionId);
  },
});

function addEntry() {
  const entry: TechEntry = {
    name: "",
    template: null,
    base_tech: null,
    active: true,
    extraParams: [],
  };
  entries.value.push(entry);
  const key = rowKey(entries.value[entries.value.length - 1]);
  openRows.value = [...openRows.value, key];
  focus.request(key);
  markDirty();
}

function removeEntry(entry: TechEntry) {
  const i = entries.value.indexOf(entry);
  if (i !== -1) entries.value.splice(i, 1);
  markDirty();
}

const onChange = markDirty;

/**
 * What this technology gets from its template and from the data tables.
 *
 * Per entry rather than per editor: the accordion shows every technology in the
 * file, and each inherits from a different template.
 */
function inheritedFor(entry: TechEntry) {
  return collectInherited(
    entry.template,
    entry.template ? templatesData.value[entry.template] : undefined,
    dataTableParams.value[entry.name],
  );
}

/** What removing this technology takes with it, for the confirmation. */
function owns(entry: TechEntry): string {
  const set = entry.extraParams.length + (entry.template ? 1 : 0) + (entry.base_tech ? 1 : 0);
  return set ? formatCount(set, "parameter") : "";
}

</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="techs-editor">
    <StateMessage v-if="isLoading" variant="block" loading>
      Loading technologies…
    </StateMessage>
    <StateMessage v-else-if="error" variant="block" tone="danger">{{ error }}</StateMessage>

    <template v-else>
      <EditorToolbar
        :saving="isSaving"
        :disabled="locked"
        :error="saveError"
        :conflict="conflict"
        :file="filePath"
        :tab-id="tabId"
        @save="save"
        @reload="reload"
      >
        <button
          v-if="!entryName"
          type="button"
          :class="GHOST_BUTTON"
          data-testid="add-tech"
          :disabled="locked"
          @click="addEntry"
        >
          <Plus class="size-3.5" />
          Add technology
        </button>
      </EditorToolbar>
      <LockedBanner v-if="lockOwner" :owner="lockOwner" :file="filePath" />

      <fieldset :disabled="locked" class="min-h-0 flex-1 overflow-auto">
        <StateMessage v-if="!visibleEntries.length" variant="block">
          {{
            entryName
              ? `No technology called “${entryName}”.`
              : "No technologies defined yet."
          }}
          <template v-if="!entryName" #action>
            <button type="button" :class="GHOST_BUTTON" :disabled="locked" @click="addEntry">
              <Plus class="size-3.5" />
              Add technology
            </button>
          </template>
        </StateMessage>

        <Accordion v-else v-model="openRows" type="multiple" class="px-2 py-1">
          <EntryAccordionRow
            v-for="entry in visibleEntries"
            :key="rowKey(entry)"
            :value="rowKey(entry)"
            :name="entry.name || '(unnamed)'"
            remove-label="Remove this technology"
            :owns="owns(entry)"
            testid="entry-row"
            @remove="removeEntry(entry)"
          >
            <template #meta>
              <Badge v-if="entry.base_tech" variant="outline" :class="ACCENT_BADGE">
                {{ entry.base_tech }}
              </Badge>
            </template>

            <!-- name is the mapping key, not a parameter. -->
            <FieldRow label="name" width="short">
              <input
                v-model="entry.name"
                type="text"
                data-testid="entry-name"
                :ref="(el) => focus.bind(el, rowKey(entry))"
                :class="FIELD"
                @input="onChange"
              />
            </FieldRow>

            <FieldRow label="template" width="short">
              <input
                :value="entry.template ?? ''"
                type="text"
                placeholder="(none)"
                :class="FIELD"
                @change="
                  entry.template =
                    ($event.target as HTMLInputElement).value || null;
                  onChange();
                "
              />
            </FieldRow>

            <FieldRow
              label="base_tech"
              width="short"
              :inherited="inheritedFor(entry).base_tech ?? null"
              :is-set="techSetsKey(entry, 'base_tech')"
              @revert="
                entry.base_tech = null;
                onChange();
              "
            >
              <Select
                :model-value="entry.base_tech ?? NONE"
                @update:model-value="
                  entry.base_tech = $event === NONE ? null : String($event);
                  onChange();
                "
              >
                <SelectTrigger
                  size="sm"
                  class="w-full"
                  aria-label="base_tech"
                  data-testid="entry-base-tech"
                >
                  <SelectValue>{{ entry.base_tech ?? "—" }}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <!-- Blank first: base_tech usually comes from the template,
                       and setting it here is an override, not a requirement. -->
                  <SelectItem :value="NONE">—</SelectItem>
                  <SelectItem v-for="option in BASE_TECH_OPTIONS" :key="option" :value="option">
                    {{ option }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </FieldRow>

            <FieldRow
              label="active"
              width="auto"
              :inherited="inheritedFor(entry).active ?? null"
              :is-set="techSetsKey(entry, 'active')"
              @revert="
                entry.active = true;
                onChange();
              "
            >
              <Switch v-model="entry.active" @update:model-value="onChange" />
            </FieldRow>

            <ParamRows
              :params="entry.extraParams"
              :inherited="inheritedFor(entry)"
              :promoted="PROMOTED"
              @change="onChange"
            />
          </EntryAccordionRow>
        </Accordion>
      </fieldset>
    </template>
  </div>
</template>
