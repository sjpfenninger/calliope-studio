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
import StateMessage from "@/components/app/StateMessage.vue";
import FieldRow from "@/components/app/FieldRow.vue";
import { Plus } from "@lucide/vue";

import { getDataTableParams } from "@/api/versions";
import { useSectionEditor } from "@/composables/useSectionEditor";
import EditorToolbar from "./EditorToolbar.vue";
import ParamRows from "./ParamRows.vue";
import { Accordion } from "@/components/ui/accordion";
import EntryAccordionRow from "./EntryAccordionRow.vue";
import { Switch } from "@/components/ui/switch";
import { FIELD, GHOST_BUTTON } from "@/lib/formClasses";

import { type DataTableParam } from "@/lib/dataTableParams";
import { collectInherited, techSetsKey } from "@/lib/inherited";
import { useComponentTreeStore } from "@/stores/componentTree";
import { useTemplatesStore } from "@/stores/templates";
import { isTransmission, mergeIntoSection, type RawTech } from "@/lib/techs";
import {
  entryKey,
  rawToTech,
  techToRaw,
  type TechEntry,
} from "@/lib/entries";

const props = defineProps<{
  versionId: string;
  filePath: string;
  tabId: string;
  entryName?: string | null;
}>();

const componentTreeStore = useComponentTreeStore();
const templatesStore = useTemplatesStore();

const BASE_TECH_OPTIONS = ["supply", "demand", "storage", "transmission", "conversion"];

const entries = ref<TechEntry[]>([]);
// The section as loaded, so the transmission entries LinksEditor owns survive a
// save from here.
const originalSection = ref<Record<string, RawTech>>({});
// Map from template name → its raw fields (merged from all files that define templates)
const templatesData = computed(() => templatesStore.templates);

// Map from tech name → param name → data-table info
const dataTableParams = ref<Record<string, Record<string, DataTableParam>>>({});

// When entryName is set (entry tab), show only the matching entry
const visibleEntries = computed(() =>
  props.entryName
    ? entries.value.filter((e) => e.name === props.entryName)
    : entries.value
);

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

function ownedHere(name: string): boolean {
  return !isTransmission(originalSection.value[name] ?? null, templatesData.value);
}

function buildPayload(): Record<string, RawTech> {
  const edited: Record<string, RawTech> = {};
  for (const e of entries.value) {
    if (e.name) edited[e.name] = techToRaw(e);
  }
  // Transmission entries belong to LinksEditor; writing only what is shown here
  // would delete every link in the file.
  return mergeIntoSection(originalSection.value, edited, ownedHere);
}

const { isLoading, isSaving, error, saveError, save, markDirty } = useSectionEditor({
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
    entries.value = Object.entries(originalSection.value)
      .filter(([, raw]) => !isTransmission(raw, templatesData.value))
      .map(([name, raw]) => rawToTech(name, raw));
    await loadDataTableParams();
    // The provenance marker on each field links to the template or table that
    // supplies the value, and the tree is what says which file holds it.
    await componentTreeStore.load(props.versionId);
  },
  build: buildPayload,
  async after(written) {
    // The merged whole becomes the new baseline, or the next save would compute
    // its merge against the section as it was two saves ago.
    if (written) originalSection.value = written as Record<string, RawTech>;
    // Editing a tech can change what a template means for its siblings.
    await templatesStore.refresh(props.versionId);
  },
});

function addEntry() {
  entries.value.push({ name: "", template: null, base_tech: null, active: true, extraParams: [] });
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

</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <StateMessage v-if="isLoading" variant="block" loading>
      Loading techs…
    </StateMessage>
    <StateMessage v-else-if="error" variant="block" tone="danger">{{ error }}</StateMessage>

    <template v-else>
      <EditorToolbar :saving="isSaving" :error="saveError" @save="save">
        <button v-if="!entryName" type="button" :class="GHOST_BUTTON" @click="addEntry">
          <Plus class="size-3.5" />
          Add tech
        </button>
      </EditorToolbar>

      <div class="min-h-0 flex-1 overflow-auto">
        <StateMessage v-if="!visibleEntries.length" variant="block">
          {{ entryName ? `No tech called "${entryName}".` : "No techs defined yet." }}
        </StateMessage>

        <Accordion
          v-else
          type="multiple"
          :default-value="visibleEntries.map((e) => entryKey(e, entries))"
          class="px-2"
        >
          <EntryAccordionRow
            v-for="entry in visibleEntries"
            :key="entryKey(entry, entries)"
            :value="entryKey(entry, entries)"
            :name="entry.name || '(unnamed)'"
            remove-label="Remove this technology"
            @remove="removeEntry(entry)"
          >
            <template #meta>
              <span
                v-if="entry.base_tech"
                class="shrink-0 rounded-xs bg-accent-soft px-1 text-2xs text-accent-text"
              >
                {{ entry.base_tech }}
              </span>
            </template>

            <!-- name is the mapping key, not a parameter. -->
            <FieldRow label="name" width="short">
              <input
                v-model="entry.name"
                type="text"
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
              <select
                :value="entry.base_tech ?? ''"
                :class="FIELD"
                @change="
                  entry.base_tech =
                    ($event.target as HTMLSelectElement).value || null;
                  onChange();
                "
              >
                <!-- Blank first: base_tech usually comes from the template,
                     and setting it here is an override, not a requirement. -->
                <option value="">—</option>
                <option v-for="option in BASE_TECH_OPTIONS" :key="option" :value="option">
                  {{ option }}
                </option>
              </select>
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
      </div>
    </template>
  </div>
</template>
