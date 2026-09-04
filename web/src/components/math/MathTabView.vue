<script setup lang="ts">
/**
 * The model's math, as a tab.
 *
 * Custom math is how a modeller changes what the optimisation *is* — adding a
 * constraint, replacing a base one, adding a decision variable — and until this
 * it was absent from the application entirely: `math_paths` and `extra_math` are
 * hidden in the config editor, a math file appeared only as one more YAML in the
 * file tree, and nothing anywhere said what any of it meant.
 *
 * One tab rather than one per component, and no source in the tab id, because
 * the point is **cross-reference**. A user's constraint refers to base
 * parameters and is referred to by base expressions; following those links is
 * how you find out whether what you wrote does what you meant. Opening a tab per
 * hop would make that unusable within three clicks.
 *
 * The two halves have very different costs, and the layout says so. The sources
 * list and the files panel come from a YAML walk that answers instantly and
 * works on a model that does not build — which is exactly the state somebody
 * wiring up their first math file is in. The notation is Calliope's LaTeX
 * backend over the whole formulation, seconds of CPU in a subprocess, so it is
 * asked for once when the tab opens and never silently repeated.
 */
import { computed, onMounted, watch } from "vue";
import { FileCode2, RefreshCw, Sigma, Square } from "@lucide/vue";

import Eyebrow from "@/components/app/Eyebrow.vue";
import PanelHeader from "@/components/app/PanelHeader.vue";
import StateMessage from "@/components/app/StateMessage.vue";
import TreeSearch from "@/components/app/TreeSearch.vue";
import MathComponentRow from "@/components/math/MathComponentRow.vue";
import MathFilesPanel from "@/components/math/MathFilesPanel.vue";
import MathSourceFilter from "@/components/math/MathSourceFilter.vue";
import { Badge } from "@/components/ui/badge";
import {
  CODE_BLOCK,
  CODE_WELL,
  DISABLED,
  GHOST_BUTTON,
  IDENTIFIER,
  INLINE_LINK,
  SECONDARY_BUTTON,
  WARNING_BADGE,
} from "@/lib/formClasses";
import { formatCount } from "@/lib/format";
import { renderMarkdown } from "@/lib/markdown";
import { hasRenderError, renderLatex } from "@/lib/mathRender";
import { openIntent } from "@/lib/openIntent";
import { cn } from "@/lib/utils";
import { componentKey, useMathStore } from "@/stores/math";
import { useTabsStore } from "@/stores/tabs";
import type { MathComponent } from "@/api/versions";

const props = defineProps<{ versionId: string }>();

const math = useMathStore();
const tabs = useTabsStore();

const rendering = computed(() => math.phase === "rendering");

/** Everything the list is narrowed by, undone at once. */
function clearFilters() {
  math.query = "";
  math.focusSource(null);
}

/**
 * The component list, after the source filter, the user filter and the query.
 *
 * Split into what the model formulates and what it switches off. One filter
 * pass over one array, partitioned after: the two halves answer to exactly the
 * same predicate, and writing it twice is how they would come to disagree.
 */
const groups = computed(() => {
  const needle = math.query.trim().toLowerCase();
  return (math.payload?.groups ?? [])
    .map((group) => {
      const components = group.components.filter((component) => {
        if (math.sourceFilter && component.origin !== math.sourceFilter) return false;
        if (math.userOnly && !isUserComponent(component)) return false;
        if (!needle) return true;
        return (
          component.name.toLowerCase().includes(needle) ||
          component.description.toLowerCase().includes(needle)
        );
      });
      return {
        ...group,
        components,
        active: components.filter((component) => !component.deactivated),
        deactivated: components.filter((component) => component.deactivated),
      };
    })
    .filter((group) => group.components.length > 0);
});

const total = computed(() =>
  groups.value.reduce((count, group) => count + group.components.length, 0),
);

const selected = computed<MathComponent | null>(() =>
  math.selectedKey ? (math.componentsByKey.get(math.selectedKey) ?? null) : null,
);

const equation = computed(() =>
  selected.value?.latex ? renderLatex(selected.value.latex) : null,
);

/**
 * Whether a component comes from a math file in this workspace.
 *
 * Read off `origin` — the *last* source to define the name — rather than off
 * `sources` containing a user file, because that is what is actually in effect.
 */
function isUserComponent(component: MathComponent): boolean {
  if (!component.origin) return false;
  return math.sources.some(
    (source) => source.name === component.origin && source.kind === "user",
  );
}

/** Where a user-declared component is written, if we know. */
const declaredAt = computed(() => {
  const component = selected.value;
  if (!component) return null;
  const found = math.locations[component.group]?.[component.name];
  return found?.file ? found : null;
});

/**
 * One click rule for both branches. The line-numbered path used to preview and
 * the bare one open for keeps — whether the tab stayed depended on whether the
 * server had found a line number, which is nothing the user can see.
 */
function openDeclaration(event: MouseEvent) {
  const found = declaredAt.value;
  if (!found) return;
  const intent = openIntent(event);
  if (found.line != null) tabs.jumpTo(found.file, found.line, 1, intent);
  else tabs.openFile(found.file, intent);
}

const status = computed(() => {
  if (rendering.value) return "Rendering the math…";
  if (math.phase === "idle") return "Not yet rendered";
  return formatCount(math.componentCount, "component");
});

/** "Render" until there is something to render again. */
const renderLabel = computed(() => (math.payload ? "Render again" : "Render"));

function refresh() {
  math.render(props.versionId);
}

onMounted(async () => {
  await math.loadSources(props.versionId);
  // Once, on open. Re-rendering costs seconds and is only worth doing when the
  // user asks or the model has actually changed — `isStale` is what says so.
  if (math.phase === "idle") math.render(props.versionId);
});

// A model switch inside one window invalidates everything, sources included.
watch(
  () => props.versionId,
  async (next, previous) => {
    if (next === previous) return;
    math.reset();
    await math.loadSources(next);
    math.render(next);
  },
);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="math-tab">
    <PanelHeader tone="surface">
      <span class="text-sm" data-testid="math-status">{{ status }}</span>
      <Badge v-if="math.payload?.mode && math.payload.mode !== 'base'" variant="outline">
        {{ math.payload.mode }} mode
      </Badge>

      <div class="flex-1" />

      <button
        v-if="rendering"
        type="button"
        data-testid="math-cancel"
        :class="SECONDARY_BUTTON"
        @click="math.cancel()"
      >
        <Square class="size-3.5" />
        Cancel rendering
      </button>
      <button
        v-else
        type="button"
        data-testid="math-refresh"
        :class="GHOST_BUTTON"
        @click="refresh"
      >
        <RefreshCw class="size-3.5" />
        {{ renderLabel }}
      </button>
    </PanelHeader>

    <!-- The model changed under a rendering that is still on screen. Neither
         silently re-rendering (seconds of unexplained work) nor silently leaving
         it (notation that is not this model's, which looks exactly like notation
         that is) is honest, so it says so and offers the button. -->
    <!-- No icon here: `StateMessage` draws its own for a non-muted tone, and the
         button goes in the `action` slot rather than the default one, which is
         wrapped in a `<p>`. -->
    <StateMessage v-if="math.isStale && !rendering" variant="inline" tone="warning">
      The model has changed since this was rendered.
      <template #action>
        <button type="button" :class="SECONDARY_BUTTON" @click="refresh">
          Render again
        </button>
      </template>
    </StateMessage>

    <div class="flex min-h-0 flex-1">
      <!-- ── Left: sources, filters, component list ───────────────────────── -->
      <div class="flex w-56 shrink-0 flex-col border-r border-border bg-panel">
        <MathFilesPanel :versionId="versionId" />

        <TreeSearch
          v-model="math.query"
          label="Filter math components"
          placeholder="Filter components…"
          testid="math-filter"
        />

        <MathSourceFilter />

        <div class="min-h-0 flex-1 overflow-auto" data-testid="math-list">
          <template v-for="group in groups" :key="group.key">
            <Eyebrow class="sticky top-0 mb-1 block bg-panel px-2 pt-1.5">
              {{ group.label }}
            </Eyebrow>
            <MathComponentRow
              v-for="component in group.active"
              :key="componentKey(component)"
              :component="component"
              :mine="isUserComponent(component)"
            />

            <!-- Under their own heading rather than mixed in: they are not part
                 of the formulation, and a reader scanning the constraints of a
                 model should not have to check a badge on every row. -->
            <template v-if="group.deactivated.length">
              <Eyebrow
                class="sticky top-0 mb-1 block bg-panel px-2 pt-1.5"
                data-testid="math-deactivated"
              >
                Deactivated ({{ group.deactivated.length }})
              </Eyebrow>
              <MathComponentRow
                v-for="component in group.deactivated"
                :key="componentKey(component)"
                :component="component"
                :mine="isUserComponent(component)"
              />
            </template>
          </template>

          <!-- Names the query, because a message that does not is
               indistinguishable from an empty formulation. -->
          <StateMessage v-if="!total && math.payload" variant="inline">
            <template v-if="math.query.trim()">Nothing matches “{{ math.query.trim() }}”</template>
            <template v-else>Nothing matches this filter</template>
            <template #action>
              <button type="button" :class="SECONDARY_BUTTON" @click="clearFilters">
                Clear
              </button>
            </template>
          </StateMessage>
        </div>
      </div>

      <!-- ── Right: the selected component ────────────────────────────────── -->
      <div class="min-h-0 flex-1 overflow-auto bg-surface" data-testid="math-detail">
        <StateMessage v-if="math.renderError" variant="fill" tone="danger">
          {{ math.renderError }}
        </StateMessage>

        <StateMessage v-else-if="rendering && !math.payload" variant="fill" loading>
          Calliope is reading the model and rendering every equation. This takes a
          few seconds, and longer on a large model.
        </StateMessage>

        <StateMessage v-else-if="!math.payload" variant="fill" :icon="Sigma">
          Press Render to read this model's math.
        </StateMessage>

        <StateMessage v-else-if="!selected" variant="fill" :icon="Sigma">
          Pick a component to see its equation.
        </StateMessage>

        <div v-else class="flex flex-col gap-3 p-3">
          <div class="flex flex-col gap-1">
            <Eyebrow>{{
              math.payload.groups.find((group) => group.key === selected!.group)?.label ??
              selected.group
            }}</Eyebrow>
            <h2 class="text-lg font-semibold text-foreground">{{ selected.name }}</h2>
            <p v-if="selected.title" class="text-sm text-text-dim">
              {{ selected.title }}
            </p>
          </div>

          <div class="flex flex-wrap items-center gap-1">
            <Badge v-if="selected.origin" variant="outline" data-testid="math-origin">
              from {{ selected.origin }}
            </Badge>
            <!-- The single most important thing a custom-math author needs to
                 see, and the one thing that is invisible in the YAML: this name
                 was already defined, and their file replaced it. -->
            <Badge v-if="selected.overridden" variant="outline" :class="WARNING_BADGE">
              replaces {{ selected.sources.slice(0, -1).join(", ") }}
            </Badge>
            <Badge v-if="selected.unit" variant="outline">{{ selected.unit }}</Badge>
            <Badge v-if="selected.default !== undefined" variant="outline">
              default {{ selected.default }}
            </Badge>
            <Badge v-if="selected.dtype" variant="outline">{{ selected.dtype }}</Badge>

            <button
              v-if="declaredAt"
              type="button"
              :class="[GHOST_BUTTON, 'ml-auto']"
              data-testid="math-open-declaration"
              @click="openDeclaration"
            >
              <FileCode2 class="size-3.5" />
              {{ declaredAt.file }}<template v-if="declaredAt.line">
                :{{ declaredAt.line }}</template>
            </button>
          </div>

          <!-- Calliope writes `code` spans into its descriptions, so they are
               markdown — through the same renderer as a README, `html: false`
               and all. -->
          <div
            v-if="selected.description"
            class="cg-markdown cg-markdown-dense"
            v-html="renderMarkdown(selected.description)"
          />

          <!-- Said here as well as in the list, because the detail pane is
               reachable without the heading above it ever being on screen, and
               an empty notation area otherwise reads as a rendering failure. -->
          <StateMessage
            v-if="selected.deactivated"
            variant="inline"
            tone="warning"
            data-testid="math-deactivated-note"
          >
            Switched off with <span :class="IDENTIFIER">active: false</span>
            <template v-if="selected.origin"> in {{ selected.origin }}</template
            >, so it is not part of this model's formulation.
          </StateMessage>

          <!-- The other reason there is no equation. Neutral rather than a
               warning: in a small model this is the resting state of most of
               `base.yaml`, and the reader wants the `where:` below, not alarm. -->
          <StateMessage
            v-if="selected.unmatched"
            variant="inline"
            data-testid="math-unmatched-note"
          >
            Applies to nothing in this model: its
            <span :class="IDENTIFIER">where</span> condition matches no node,
            technology, carrier or timestep here, so it adds nothing to the
            formulation. The definition below says what it looks for.
          </StateMessage>

          <div v-if="equation" class="cg-math" data-testid="math-equation" v-html="equation.html" />
          <StateMessage v-if="equation && hasRenderError(equation)" variant="inline" tone="warning">
            This equation could not be typeset.
          </StateMessage>

          <!-- Each name is a word in a run of text that goes somewhere, which is
               what `INLINE_LINK` is; a name the rendering did not reach — a
               parameter the model never set — is left in place but inert. -->
          <div
            v-if="selected.uses.length || selected.used_in.length"
            class="flex flex-col gap-1.5 text-sm text-text-dim"
          >
            <div v-if="selected.uses.length" class="flex flex-wrap items-baseline gap-1">
              <Eyebrow>Uses</Eyebrow>
              <button
                v-for="name in selected.uses"
                :key="name"
                type="button"
                :class="cn(INLINE_LINK, DISABLED)"
                :disabled="!math.componentsByName.has(name)"
                :data-math-ref="name"
                @click="math.selectByName(name)"
              >
                {{ name }}
              </button>
            </div>
            <div
              v-if="selected.used_in.length"
              class="flex flex-wrap items-baseline gap-1"
            >
              <Eyebrow>Used in</Eyebrow>
              <button
                v-for="name in selected.used_in"
                :key="name"
                type="button"
                :class="cn(INLINE_LINK, DISABLED)"
                :disabled="!math.componentsByName.has(name)"
                :data-math-ref="name"
                @click="math.selectByName(name)"
              >
                {{ name }}
              </button>
            </div>
          </div>

          <!-- The YAML is the *cause* of the notation above it, so somebody
               writing math needs both on one screen. -->
          <div v-if="selected.yaml" class="flex flex-col gap-1">
            <Eyebrow>Definition</Eyebrow>
            <pre :class="cn(CODE_WELL, CODE_BLOCK, 'overflow-auto')">{{ selected.yaml }}</pre>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
