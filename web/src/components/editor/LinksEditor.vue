<script setup lang="ts">
/**
 * LinksEditor — the transmission technologies in a file's `techs:` section.
 *
 * Calliope 0.7 has no `links:` section: a link is an ordinary technology
 * carrying `link_from` and `link_to`. This editor shows only those, with the
 * endpoints promoted to their own fields, because that is what distinguishes a
 * link from any other technology.
 *
 * It shares the `techs:` section with TechsEditor, so it reloads the whole
 * section on save and writes back the entries it does not own untouched.
 *
 * The default view is the map, where a link is *drawn* rather than described:
 * click one node, then another, and the link between them is created from the
 * template the picker names. Clicking a line opens that link's form underneath.
 * Node positions come from the saved model — this view does not move nodes — but
 * the lines are built from the entries in hand, so a link that exists only in the
 * form is already on the map.
 */
import { ref, computed } from "vue";
import StateMessage from "@/components/app/StateMessage.vue";
import TooltipButton from "@/components/app/TooltipButton.vue";
// `Map` is aliased: unaliased it shadows the global `Map` constructor, which is
// used below and fails in a way that points at the wrong line entirely.
import { List, Map as MapIcon, Plus, Trash2, X } from "@lucide/vue";

import { useSectionEditor } from "@/composables/useSectionEditor";
import EditorMapPane from "./EditorMapPane.vue";
import EditorToolbar from "./EditorToolbar.vue";
import LinkFields from "./LinkFields.vue";
import { Accordion } from "@/components/ui/accordion";
import EntryAccordionRow from "./EntryAccordionRow.vue";
import {
  FIELD,
  FIELD_LABEL,
  GHOST_BUTTON,
  IDENTIFIER,
} from "@/lib/formClasses";

import { cn } from "@/lib/utils";
import { useModelGeo } from "@/composables/useModelGeo";
import { useTabsStore } from "@/stores/tabs";
import { useComponentTreeStore } from "@/stores/componentTree";
import { useTemplatesStore } from "@/stores/templates";
import { useUiStore } from "@/stores/ui";
import { isTransmission, mergeIntoSection, type RawTech } from "@/lib/techs";
import {
  buildGeo,
  linksFromFeatures,
  nodesFromFeatures,
  type MapLink,
} from "@/lib/mapGeo";
import {
  entryKey,
  linkToRaw,
  rawToLink,
  type LinkEntry,
} from "@/lib/entries";

const props = defineProps<{
  versionId: string;
  filePath: string;
  tabId: string;
  entryName?: string | null;
}>();

// Only for `openEntry`; the dirty/clean bookkeeping is the composable's.
const tabsStore = useTabsStore();
const componentTreeStore = useComponentTreeStore();
const templatesStore = useTemplatesStore();
const ui = useUiStore();


const entries = ref<LinkEntry[]>([]);
/** The section as loaded, so entries owned by TechsEditor survive a save. */
const originalSection = ref<Record<string, RawTech>>({});
const templatesData = computed(() => templatesStore.templates);

const { geo: savedGeo, error: geoError, reload: reloadGeo } = useModelGeo(
  computed(() => props.versionId),
);

/** Which link the map has selected, and so whose form is shown below it. */
const activeLink = ref<string | null>(null);

/** First endpoint of a link being drawn, waiting for its second click. */
const pendingFrom = ref<string | null>(null);

const nodeNames = computed(() =>
  (componentTreeStore.tree?.nodes?.entries ?? []).map((entry) =>
    typeof entry === "string" ? entry : entry.name,
  ),
);

const visibleEntries = computed(() =>
  props.entryName
    ? entries.value.filter((entry) => entry.name === props.entryName)
    : entries.value,
);

const showMap = computed(() => !props.entryName && ui.sectionView.links === "map");

/**
 * The nodes a link can be drawn between: the saved ones, which are the only ones
 * with a position. Never editable — moving a node belongs to the nodes editor.
 */
const mapNodes = computed(() => nodesFromFeatures(savedGeo.value?.nodes));

/**
 * The lines: this editor's entries, live, plus the links defined in other files.
 *
 * Colour is the entry's own `color`, then its template's, then whatever the server
 * drew it with — so recolouring a link in the form shows on the map before saving.
 */
const mapLinks = computed<MapLink[]>(() => {
  const savedColors = new Map(
    linksFromFeatures(savedGeo.value?.links).map((link) => [link.name, link.color]),
  );
  const mine = entries.value
    .filter((entry) => entry.name && entry.linkFrom && entry.linkTo)
    .map((entry) => ({
      name: entry.name,
      from: entry.linkFrom,
      to: entry.linkTo,
      color: linkColor(entry) ?? savedColors.get(entry.name),
    }));
  const names = new Set(entries.value.map((entry) => entry.name));
  const elsewhere = linksFromFeatures(savedGeo.value?.links).filter(
    (link) => !names.has(link.name),
  );
  return [...mine, ...elsewhere];
});

const mapGeo = computed(() =>
  buildGeo(mapNodes.value, mapLinks.value, savedGeo.value?.colors),
);

/**
 * Nodes with nowhere to be drawn.
 *
 * The component tree is the merged list of every node in the model; the geo
 * endpoint drops exactly the ones without coordinates. The difference is what
 * cannot be linked yet, and greys the map out.
 */
const missing = computed(() => {
  const placed = new Set(mapNodes.value.map((node) => node.name));
  return nodeNames.value.filter((name) => !placed.has(name));
});

const activeEntry = computed(
  () => entries.value.find((entry) => entry.name === activeLink.value) ?? null,
);

/** Where a link the map shows but this editor does not own is defined. */
const activeElsewhere = computed(() => {
  if (!activeLink.value || activeEntry.value) return null;
  const found = (componentTreeStore.tree?.links?.entries ?? []).find(
    (entry) => typeof entry !== "string" && entry.name === activeLink.value,
  );
  return typeof found === "string" || !found ? null : found;
});

/**
 * Templates offered for a new link.
 *
 * Those that *are* transmission, plus any a link already uses — a template like
 * `free_transmission` declares `base_tech: transmission`, but one that only sets
 * costs and is combined with an explicit `base_tech` would otherwise be invisible
 * here. If nothing qualifies, offer everything rather than an empty list.
 */
const linkTemplates = computed(() => {
  const used = new Set(
    Object.values(originalSection.value)
      .map((raw) => (raw && typeof raw === "object" ? raw.template : null))
      .filter((name): name is string => Boolean(name)),
  );
  const names = Object.keys(templatesData.value).filter(
    (name) => templatesData.value[name]?.base_tech === "transmission" || used.has(name),
  );
  return names.length ? names : Object.keys(templatesData.value);
});

function linkColor(entry: LinkEntry): string | undefined {
  const own = entry.params.find((param) => param.key === "color")?.value;
  if (typeof own === "string" && own.startsWith("#")) return own;
  const inherited = entry.template
    ? templatesData.value[entry.template]?.color
    : undefined;
  return typeof inherited === "string" && inherited.startsWith("#")
    ? inherited
    : undefined;
}

function owned(name: string): boolean {
  return isTransmission(originalSection.value[name] ?? null, templatesData.value);
}

/**
 * The model's templates, resolved.
 *
 * From the store rather than merged out of each file's raw `templates:` section:
 * that only ever resolved one hop, so a template inheriting a template showed half
 * of what an entry inherits — and made this editor's own idea of what a
 * transmission tech is disagree with Calliope's.
 */
async function loadTemplates() {
  await templatesStore.load(props.versionId);
}

function buildPayload(): Record<string, RawTech> {
  const edited: Record<string, RawTech> = {};
  for (const entry of entries.value) {
    if (entry.name) edited[entry.name] = linkToRaw(entry, templatesData.value);
  }
  return mergeIntoSection(originalSection.value, edited, owned);
}

const { isLoading, isSaving, error, saveError, save, markDirty } = useSectionEditor({
  versionId: () => props.versionId,
  filePath: () => props.filePath,
  tabId: () => props.tabId,
  section: "techs",
  label: "transmission technologies",
  async apply(data) {
    // Templates first: `base_tech: transmission` usually arrives through one, so
    // nothing can be classified as a link without them.
    await loadTemplates();
    originalSection.value = data as Record<string, RawTech>;
    entries.value = Object.entries(originalSection.value)
      .filter(([, raw]) => isTransmission(raw, templatesData.value))
      .map(([name, raw]) => rawToLink(name, raw));
    // The provenance marker on each field links to the template or table that
    // supplies the value, and the tree is what says which file holds it.
    await componentTreeStore.load(props.versionId);
  },
  build: buildPayload,
  async after(written) {
    // The merged whole becomes the new baseline: TechsEditor owns the rest of
    // this section, and the next save has to merge against what was written.
    if (written) originalSection.value = written as Record<string, RawTech>;
    // Adding or removing a link changes the explorer and the map.
    await componentTreeStore.refresh(props.versionId);
    // A save can change what entries inherit, so the resolved templates the
    // forms display have to be re-read too.
    await templatesStore.refresh(props.versionId);
    await reloadGeo();
  },
});

const onChange = markDirty;

function addEntry() {
  entries.value.push({
    name: "",
    linkFrom: "",
    linkTo: "",
    template: null,
    active: true,
    params: [],
  });
  // An unnamed link with no endpoints cannot be drawn, so adding one this way is
  // also a request to see the list.
  ui.setSectionView("links", "structured");
  onChange();
}

function removeEntry(entry: LinkEntry) {
  const index = entries.value.indexOf(entry);
  if (index !== -1) entries.value.splice(index, 1);
  if (activeLink.value === entry.name) activeLink.value = null;
  onChange();
}

/** `region1_to_region2`, the convention in Calliope's own example models. */
function nameFor(from: string, to: string): string {
  const base = `${from}_to_${to}`;
  const taken = new Set([
    ...Object.keys(originalSection.value),
    ...entries.value.map((entry) => entry.name),
  ]);
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

/**
 * The two-click flow: first node picked, second node connects.
 *
 * Clicking the pending node again cancels, which is what a second thought looks
 * like when the pointer has not moved.
 */
function onNodeClick(node: string) {
  if (!pendingFrom.value) {
    pendingFrom.value = node;
    return;
  }
  if (pendingFrom.value === node) {
    pendingFrom.value = null;
    return;
  }
  const entry: LinkEntry = {
    name: nameFor(pendingFrom.value, node),
    linkFrom: pendingFrom.value,
    linkTo: node,
    template: ui.newLinkTemplate,
    active: true,
    params: [],
  };
  entries.value.push(entry);
  activeLink.value = entry.name;
  pendingFrom.value = null;
  onChange();
}

function openElsewhere() {
  const target = activeElsewhere.value;
  if (target?.file && target.name) {
    tabsStore.openEntry("links", target.file, target.name);
  }
}

</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <StateMessage v-if="isLoading" variant="block" loading>
      Loading transmission technologies…
    </StateMessage>
    <StateMessage v-else-if="error" variant="block" tone="danger">{{ error }}</StateMessage>

    <template v-else>
      <EditorToolbar :saving="isSaving" :error="saveError" :file="filePath" @save="save">
        <button v-if="!entryName" type="button" :class="GHOST_BUTTON" @click="addEntry">
          <Plus class="size-3.5" />
          Add link
        </button>
        <button
          v-if="!entryName"
          type="button"
          data-testid="view-toggle"
          :class="GHOST_BUTTON"
          @click="ui.toggleSectionView('links')"
        >
          <component
            :is="showMap ? List : MapIcon"
            class="size-3.5"
          />
          {{ showMap ? "List" : "Map" }}
        </button>
      </EditorToolbar>

      <EditorMapPane
        v-if="showMap"
        :geo="mapGeo"
        :selected="pendingFrom ? [pendingFrom] : []"
        :missing="missing"
        :error="geoError"
        :pending-link-from="pendingFrom"
        interactive-links
        @node-click="onNodeClick"
        @link-click="activeLink = $event"
        @show-list="ui.setSectionView('links', 'structured')"
      >
        <template #empty>
          No nodes to link yet — add nodes with coordinates first.
        </template>

        <template #toolbar>
          <label :class="FIELD_LABEL" for="new-link-template">
            new links use
          </label>
          <select
            id="new-link-template"
            data-testid="new-link-template"
            :class="cn(FIELD, 'w-auto')"
            :value="ui.newLinkTemplate ?? ''"
            @change="
              ui.newLinkTemplate = ($event.target as HTMLSelectElement).value || null
            "
          >
            <option value="">(no template)</option>
            <option v-for="name in linkTemplates" :key="name" :value="name">
              {{ name }}
            </option>
          </select>

          <span
            v-if="pendingFrom"
            class="flex items-center gap-1.5 text-sm text-text-dim"
            data-testid="pending-link"
          >
            Click a second node to link from
            <code :class="IDENTIFIER">{{ pendingFrom }}</code>
            <TooltipButton
              label="Cancel (Esc)"
              :icon="X"
              tone="danger"
              @click="pendingFrom = null"
            />
          </span>
          <span v-else class="text-sm text-text-faint">
            Click two nodes to draw a link, or a line to edit one.
          </span>
        </template>

        <template #detail>
          <template v-if="activeEntry">
            <div class="flex items-center justify-between gap-1.5">
              <span class="truncate text-sm">{{ activeEntry.name }}</span>
              <TooltipButton
                label="Remove this link"
                :icon="Trash2"
                tone="danger"
                @click="removeEntry(activeEntry)"
              />
            </div>
            <LinkFields
              :key="activeEntry.name"
              :entry="activeEntry"
              :templates="templatesData"
              @change="onChange"
            />
          </template>
          <div
            v-else-if="activeElsewhere"
            class="flex items-center gap-2 py-1 text-sm text-text-muted"
          >
            <span>
              <code :class="IDENTIFIER">{{ activeLink }}</code> is defined in
              <code :class="IDENTIFIER">{{ activeElsewhere.file }}</code>.
            </span>
            <button type="button" :class="GHOST_BUTTON" @click="openElsewhere">
              Open it
            </button>
          </div>
          <p
            v-else
            class="flex h-full items-center justify-center text-sm text-text-muted"
          >
            Click a link to edit it, or two nodes to draw a new one.
          </p>
        </template>
      </EditorMapPane>

      <div v-else class="min-h-0 flex-1 overflow-auto">
        <StateMessage v-if="!visibleEntries.length" variant="block">
          {{
            entryName
              ? `No link called "${entryName}".`
              : "No transmission technologies in this file."
          }}
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
            remove-label="Remove this link"
            @remove="removeEntry(entry)"
          >
            <template #meta>
              <span
                v-if="entry.linkFrom || entry.linkTo"
                class="shrink-0 text-2xs text-text-faint"
              >
                {{ entry.linkFrom || "?" }} → {{ entry.linkTo || "?" }}
              </span>
            </template>

              <LinkFields
                :entry="entry"
                :templates="templatesData"
                @change="onChange"
              />
          </EntryAccordionRow>
        </Accordion>
      </div>

      <!-- Once for the whole editor: both the list's forms and the map's detail
           pane point their endpoint and template fields at these. -->
      <datalist id="link-node-names">
        <option v-for="node in nodeNames" :key="node" :value="node" />
      </datalist>
      <datalist id="link-template-names">
        <option v-for="name in Object.keys(templatesData)" :key="name" :value="name" />
      </datalist>
    </template>
  </div>
</template>
