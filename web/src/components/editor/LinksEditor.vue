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
import { computed, onMounted, onUnmounted, ref, shallowRef } from "vue";
import LockedBanner from "@/components/app/LockedBanner.vue";
import Segmented from "@/components/app/Segmented.vue";
import StateMessage from "@/components/app/StateMessage.vue";
import TooltipButton from "@/components/app/TooltipButton.vue";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
// `Map` is aliased: unaliased it shadows the global `Map` constructor, which is
// used below and fails in a way that points at the wrong line entirely.
import { List, Map as MapIcon, Plus, Trash2, X } from "@lucide/vue";

import { removalRequest, useSectionEditor } from "@/composables/useSectionEditor";
import EditorMapPane from "./EditorMapPane.vue";
import EditorToolbar from "./EditorToolbar.vue";
import LinkFields from "./LinkFields.vue";
import { Accordion } from "@/components/ui/accordion";
import EntryAccordionRow from "./EntryAccordionRow.vue";
import { FIELD_LABEL, GHOST_BUTTON, IDENTIFIER } from "@/lib/formClasses";
import { formatCount } from "@/lib/format";
import { useFocusNew } from "./focusNew";

import { useModelGeo } from "@/composables/useModelGeo";
import { useConfirmStore } from "@/stores/confirm";
import { useTabsStore } from "@/stores/tabs";
import { useComponentTreeStore } from "@/stores/componentTree";
import { useTemplatesStore } from "@/stores/templates";
import { useUiStore } from "@/stores/ui";
import { mergeIntoSection, ownedNames, type RawTech } from "@/lib/techs";
import {
  buildGeo,
  linksFromFeatures,
  nodesFromFeatures,
  type MapLink,
} from "@/lib/mapGeo";
import {
  linkToRaw,
  rawToLink,
  duplicateNameError,
  duplicateNames,
  rememberName,
  renamesFor,
  rowKey,
  type LinkEntry,
} from "@/lib/entries";
import { usePinnedEntry } from "@/composables/usePinnedEntry";

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
const confirm = useConfirmStore();

/** Reka refuses `""` as an item value; see `TechsEditor`. */
const NONE = "__none__";

const entries = ref<LinkEntry[]>([]);
/**
 * Which rows are expanded, by `rowKey`. State rather than Reka's
 * `:default-value`, which is read once; extended by `addEntry`.
 */
const openRows = ref<string[]>([]);
/** The name field of a row just added takes the cursor; see `focusNew`. */
const focus = useFocusNew();
/** The section as loaded, so entries owned by TechsEditor survive a save. */
const originalSection = ref<Record<string, RawTech>>({});
const templatesData = computed(() => templatesStore.templates);

const {
  geo: savedGeo,
  source: geoSource,
  error: geoError,
  resolving: geoResolving,
  reload: reloadGeo,
} = useModelGeo(computed(() => props.versionId));

/**
 * Which link the map has selected: the entry itself, not its name.
 *
 * By identity, because the detail form can rename the link it is showing — and
 * a name lookup then matched nothing on the first keystroke, so the form the
 * user was typing in vanished mid-word. `activeName` survives alongside it for
 * a link this file does not define, where the pane names the file that does.
 */
const activeEntry = shallowRef<LinkEntry | null>(null);
const activeName = ref<string | null>(null);

function select(name: string | null) {
  activeName.value = name;
  activeEntry.value = name
    ? (entries.value.find((entry) => entry.name === name) ?? null)
    : null;
}

/** First endpoint of a link being drawn, waiting for its second click. */
const pendingFrom = ref<string | null>(null);

const nodeNames = computed(() =>
  (componentTreeStore.tree?.nodes?.entries ?? []).map((entry) =>
    typeof entry === "string" ? entry : entry.name,
  ),
);

// On an entry tab, the one entry — by identity, so renaming it keeps it.
const { visible: visibleEntries } = usePinnedEntry(entries, () => props.entryName);

const showMap = computed(() => !props.entryName && ui.sectionView.links === "map");

/**
 * Map or list, with the map segment dead while there is nothing to draw on:
 * every node the model has is unplaced. The same rule as `NodesEditor`'s.
 */
const VIEW_ITEMS = computed(() => {
  const unplaceable = mapNodes.value.length === 0 && missing.value.length > 0;
  return [
    { value: "structured" as const, label: "List", icon: List, testid: "view-list" },
    {
      value: "map" as const,
      label: "Map",
      icon: MapIcon,
      testid: "view-map",
      disabled: unplaceable,
      tip: unplaceable ? "No node has coordinates yet. Add them in the nodes list." : undefined,
    },
  ];
});

const view = computed({
  get: () => ui.sectionView.links,
  set: (next) => ui.setSectionView("links", next),
});

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
  // Before the first answer, or after a failed one with nothing kept, there
  // is no reading to be missing from — and every node read as unplaced.
  if (!savedGeo.value) return [];
  const placed = new Set(mapNodes.value.map((node) => node.name));
  return nodeNames.value.filter((name) => !placed.has(name));
});

/** Where a link the map shows but this editor does not own is defined. */
const activeElsewhere = computed(() => {
  if (!activeName.value || activeEntry.value) return null;
  const found = (componentTreeStore.tree?.links?.entries ?? []).find(
    (entry) => typeof entry !== "string" && entry.name === activeName.value,
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

/** Fixed when the section loads; see `ownedNames`. The mirror of TechsEditor. */
const ownedHere = ref<Set<string>>(new Set());

function owned(name: string): boolean {
  return ownedHere.value.has(name);
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
  const repeated = duplicateNames(entries.value);
  if (repeated.length) throw duplicateNameError(repeated, "links");
  const edited: Record<string, RawTech> = {};
  for (const entry of entries.value) {
    if (entry.name) edited[entry.name] = linkToRaw(entry, templatesData.value);
  }
  return mergeIntoSection(originalSection.value, edited, owned, renamesFor(entries.value));
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
  label: "transmission technologies",
  async apply(data) {
    // Templates first: `base_tech: transmission` usually arrives through one, so
    // nothing can be classified as a link without them.
    await loadTemplates();
    originalSection.value = data as Record<string, RawTech>;
    ownedHere.value = ownedNames(originalSection.value, templatesData.value, "links");
    entries.value = Object.entries(originalSection.value)
      .filter(([name]) => ownedHere.value.has(name))
      .map(([name, raw]) => rawToLink(name, raw));
    for (const entry of entries.value) rememberName(entry, entry.name);
    openRows.value = entries.value.map(rowKey);
    // The entries are new objects, so a selection held against the old ones is
    // none of them; re-resolve it by name, which is all a reload can do.
    select(activeName.value);
    // The provenance marker on each field links to the template or table that
    // supplies the value, and the tree is what says which file holds it.
    await componentTreeStore.load(props.versionId);
  },
  build: buildPayload,
  renames: () => renamesFor(entries.value),
  async after(written) {
    // The merged whole becomes the new baseline: TechsEditor owns the rest of
    // this section, and the next save has to merge against what was written.
    // The file now says each row's current name, so a later rename is measured
    // from that.
    if (written) {
      originalSection.value = written as Record<string, RawTech>;
      for (const entry of entries.value) {
        if (!entry.name) continue;
        ownedHere.value.add(entry.name);
        rememberName(entry, entry.name);
      }
    }
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
  const key = rowKey(entries.value[entries.value.length - 1]);
  openRows.value = [...openRows.value, key];
  focus.request(key);
  // An unnamed link with no endpoints cannot be drawn, so adding one this way is
  // also a request to see the list.
  ui.setSectionView("links", "structured");
  onChange();
}

function removeEntry(entry: LinkEntry) {
  const index = entries.value.indexOf(entry);
  if (index !== -1) entries.value.splice(index, 1);
  // By identity: the entry may have been renamed since it was selected.
  if (activeEntry.value === entry) select(null);
  onChange();
}

/** What removing this link takes with it, for the confirmation. */
function owns(entry: LinkEntry): string {
  const set = entry.params.length + (entry.template ? 1 : 0);
  return set ? formatCount(set, "parameter") : "";
}

/** The map's detail pane has no accordion row to ask for it, so it asks here. */
async function confirmRemove(entry: LinkEntry) {
  if (await confirm.ask(removalRequest(entry.name || "(unnamed)", owns(entry)))) {
    removeEntry(entry);
  }
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
  activeEntry.value = entries.value[entries.value.length - 1];
  activeName.value = entry.name;
  pendingFrom.value = null;
  onChange();
}

/**
 * Escape abandons a half-drawn link.
 *
 * The chip beside the map has said "Cancel (Esc)" since the two-click flow was
 * written, and nothing listened for it — so the one key everyone reaches for
 * left the pending endpoint armed and the next node click drew a link nobody
 * asked for. On `window`, because the click that started this went to a canvas
 * and focus is wherever it was; gated on the tab in front for the same reason
 * `useSectionEditor` gates Cmd+S, and a no-op when nothing is pending so it
 * never swallows an Escape a dialog wants.
 */
function onEscape(event: KeyboardEvent) {
  if (event.key !== "Escape" || !pendingFrom.value) return;
  if (tabsStore.activeId !== props.tabId) return;
  pendingFrom.value = null;
}

onMounted(() => window.addEventListener("keydown", onEscape));
onUnmounted(() => window.removeEventListener("keydown", onEscape));

function openElsewhere() {
  const target = activeElsewhere.value;
  if (target?.file && target.name) {
    tabsStore.openEntry("links", target.file, target.name);
  }
}

</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="links-editor">
    <StateMessage v-if="isLoading" variant="block" loading>
      Loading transmission technologies…
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
          data-testid="add-link"
          :class="GHOST_BUTTON"
          :disabled="locked"
          @click="addEntry"
        >
          <Plus class="size-3.5" />
          Add link
        </button>
        <Segmented
          v-if="!entryName"
          v-model="view"
          :items="VIEW_ITEMS"
          mode="nav"
          size="fill"
          seam="none"
        />
      </EditorToolbar>
      <LockedBanner v-if="lockOwner" :owner="lockOwner" :file="filePath" />

      <EditorMapPane
        v-if="showMap"
        :geo="mapGeo"
        :selected="pendingFrom ? [pendingFrom] : []"
        :missing="missing"
        :error="geoError"
        :source="geoSource"
        :resolving="geoResolving"
        :pending-link-from="pendingFrom"
        :interactive-links="!locked"
        @node-click="onNodeClick"
        @link-click="select($event)"
        @show-list="ui.setSectionView('links', 'structured')"
      >
        <template #empty>
          No nodes to link yet — add nodes with coordinates first.
        </template>

        <template #toolbar>
          <label :class="FIELD_LABEL" for="new-link-template">
            new links use
          </label>
          <Select
            :model-value="ui.newLinkTemplate ?? NONE"
            @update:model-value="ui.newLinkTemplate = $event === NONE ? null : String($event)"
          >
            <SelectTrigger
              id="new-link-template"
              size="sm"
              aria-label="Template for new links"
              data-testid="new-link-template"
            >
              <SelectValue>{{ ui.newLinkTemplate ?? "(no template)" }}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem :value="NONE">(no template)</SelectItem>
              <SelectItem v-for="name in linkTemplates" :key="name" :value="name">
                {{ name }}
              </SelectItem>
            </SelectContent>
          </Select>

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
          <span v-else class="text-sm text-text-muted">
            Click two nodes to draw a link, or a line to edit one.
          </span>
        </template>

        <template #detail>
          <fieldset v-if="activeEntry" :disabled="locked" class="contents">
            <div class="flex items-center justify-between gap-1.5">
              <span class="truncate text-sm">{{ activeEntry.name }}</span>
              <TooltipButton
                label="Remove this link"
                :icon="Trash2"
                tone="danger"
                size="xs"
                @click="confirmRemove(activeEntry)"
              />
            </div>
            <LinkFields
              :key="rowKey(activeEntry)"
              :entry="activeEntry"
              :templates="templatesData"
              @change="onChange"
            />
          </fieldset>
          <div
            v-else-if="activeElsewhere"
            class="flex items-center gap-2 py-1 text-sm text-text-muted"
          >
            <span>
              <code :class="IDENTIFIER">{{ activeName }}</code> is defined in
              <code :class="IDENTIFIER">{{ activeElsewhere.file }}</code>.
            </span>
            <button type="button" :class="GHOST_BUTTON" @click="openElsewhere">
              Open it
            </button>
          </div>
          <StateMessage v-else variant="fill">
            Click a link to edit it, or two nodes to draw a new one.
          </StateMessage>
        </template>
      </EditorMapPane>

      <fieldset v-else :disabled="locked" class="min-h-0 flex-1 overflow-auto">
        <StateMessage v-if="!visibleEntries.length" variant="block">
          {{
            entryName
              ? `No link called “${entryName}”.`
              : "No transmission technologies in this file."
          }}
          <template v-if="!entryName" #action>
            <button type="button" :class="GHOST_BUTTON" :disabled="locked" @click="addEntry">
              <Plus class="size-3.5" />
              Add link
            </button>
          </template>
        </StateMessage>

        <Accordion v-else v-model="openRows" type="multiple" class="px-2 py-1">
          <EntryAccordionRow
            v-for="entry in visibleEntries"
            :key="rowKey(entry)"
            :value="rowKey(entry)"
            :name="entry.name || '(unnamed)'"
            remove-label="Remove this link"
            :owns="owns(entry)"
            testid="entry-row"
            @remove="removeEntry(entry)"
          >
            <template #meta>
              <span
                v-if="entry.linkFrom || entry.linkTo"
                class="shrink-0 text-2xs text-text-muted"
              >
                {{ entry.linkFrom || "?" }} → {{ entry.linkTo || "?" }}
              </span>
            </template>

            <LinkFields
              :ref="(el) => focus.bind(el, rowKey(entry))"
              :entry="entry"
              :templates="templatesData"
              @change="onChange"
            />
          </EntryAccordionRow>
        </Accordion>
      </fieldset>

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
