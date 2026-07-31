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
import { FileCode2, RefreshCw, Sigma, X } from "@lucide/vue";

import Eyebrow from "@/components/app/Eyebrow.vue";
import PanelHeader from "@/components/app/PanelHeader.vue";
import StateMessage from "@/components/app/StateMessage.vue";
import TreeSearch from "@/components/app/TreeSearch.vue";
import MathFilesPanel from "@/components/math/MathFilesPanel.vue";
import { Badge } from "@/components/ui/badge";
import { CODE_BLOCK, GHOST_BUTTON, SECONDARY_BUTTON } from "@/lib/formClasses";
import { renderMarkdown } from "@/lib/markdown";
import { hasRenderError, renderLatex } from "@/lib/mathRender";
import { useMathStore } from "@/stores/math";
import { useTabsStore } from "@/stores/tabs";
import type { MathComponent } from "@/api/versions";

/**
 * A badge that warns without shouting.
 *
 * The hairline is the one every other badge has — `border-warning` is the
 * *saturated* token, meant for a fill, and using it as a 1px rule made these the
 * loudest thing in a sidebar of otherwise neutral rows. The soft wash behind it
 * is what the shared `Badge`'s own `destructive` variant does, so this is the
 * existing language rather than a fifth treatment.
 */
const WARNING_BADGE =
  "shrink-0 border-border-subtle bg-warning-soft px-1 font-normal text-warning-text";

const props = defineProps<{ versionId: string }>();

const math = useMathStore();
const tabs = useTabsStore();

const rendering = computed(() => math.phase === "rendering");

/**
 * Which sources the filter offers.
 *
 * Only ones that are actually applied: an unapplied file contributes nothing to
 * the rendered formulation, so filtering to it would show an empty list and read
 * as a broken filter rather than as the point being made. The files panel is
 * where an unapplied file is dealt with.
 */
const filterSources = computed(() => math.sources.filter((source) => source.applied));

const hasUserMath = computed(() =>
  math.sources.some((source) => source.kind === "user" && source.applied),
);

/** The component list, after the source filter, the user filter and the query. */
const groups = computed(() => {
  const needle = math.query.trim().toLowerCase();
  return (math.payload?.groups ?? [])
    .map((group) => ({
      ...group,
      components: group.components.filter((component) => {
        if (math.sourceFilter && component.origin !== math.sourceFilter) return false;
        if (math.userOnly && !isUserComponent(component)) return false;
        if (!needle) return true;
        return (
          component.name.toLowerCase().includes(needle) ||
          component.description.toLowerCase().includes(needle)
        );
      }),
    }))
    .filter((group) => group.components.length > 0);
});

const total = computed(() =>
  groups.value.reduce((count, group) => count + group.components.length, 0),
);

const selected = computed<MathComponent | null>(() =>
  math.selectedName ? (math.componentsByName.get(math.selectedName) ?? null) : null,
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

function openDeclaration() {
  const found = declaredAt.value;
  if (!found) return;
  if (found.line != null) tabs.jumpTo(found.file, found.line, 1);
  else tabs.openFile(found.file);
}

const status = computed(() => {
  if (rendering.value) return "Rendering the math…";
  if (math.phase === "idle") return "Not yet rendered";
  const count = math.componentsByName.size;
  return `${count} component${count === 1 ? "" : "s"}`;
});

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
    <!-- `bg-surface`: the first strip under the tab bar, which the tab opens
         onto. -->
    <PanelHeader class="bg-surface">
      <Sigma class="size-3.5 shrink-0 text-text-faint" />
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
        <X class="size-3.5" />
        Cancel
      </button>
      <button
        v-else
        type="button"
        data-testid="math-refresh"
        :class="GHOST_BUTTON"
        @click="refresh"
      >
        <RefreshCw class="size-3.5" />
        Render again
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
      <div class="flex w-64 shrink-0 flex-col border-r border-border bg-panel">
        <MathFilesPanel :versionId="versionId" />

        <TreeSearch
          v-model="math.query"
          label="Filter math components"
          placeholder="Filter components…"
          testid="math-filter"
        />

        <div
          v-if="filterSources.length > 1 || hasUserMath"
          class="flex flex-col gap-1 border-b border-border-subtle px-2 py-1.5"
        >
          <Eyebrow>Source</Eyebrow>
          <div class="flex flex-wrap gap-1" data-testid="math-source-filter">
            <button
              type="button"
              :class="[
                'rounded-xs px-1.5 py-0.5 text-2xs',
                math.sourceFilter === null && !math.userOnly
                  ? 'bg-accent-soft text-accent-text'
                  : 'text-text-muted hover:bg-hover',
              ]"
              @click="math.focusSource(null)"
            >
              All
            </button>
            <button
              v-if="hasUserMath"
              type="button"
              data-testid="math-user-only"
              :class="[
                'rounded-xs px-1.5 py-0.5 text-2xs',
                math.userOnly
                  ? 'bg-accent-soft text-accent-text'
                  : 'text-text-muted hover:bg-hover',
              ]"
              @click="
                math.sourceFilter = null;
                math.userOnly = !math.userOnly;
              "
            >
              Mine
            </button>
            <button
              v-for="source in filterSources"
              :key="source.name"
              type="button"
              :class="[
                'rounded-xs px-1.5 py-0.5 text-2xs',
                math.sourceFilter === source.name
                  ? 'bg-accent-soft text-accent-text'
                  : 'text-text-muted hover:bg-hover',
              ]"
              @click="math.focusSource(source.name)"
            >
              {{ source.name }}
            </button>
          </div>
        </div>

        <div class="min-h-0 flex-1 overflow-auto" data-testid="math-list">
          <template v-for="group in groups" :key="group.key">
            <Eyebrow class="sticky top-0 block bg-panel px-2 pt-1.5">
              {{ group.label }}
            </Eyebrow>
            <button
              v-for="component in group.components"
              :key="component.name"
              type="button"
              class="flex w-full items-center gap-1 px-2 py-0.5 text-left text-sm"
              :class="
                component.name === math.selectedName
                  ? 'bg-accent-soft text-accent-text'
                  : 'text-foreground hover:bg-hover'
              "
              :data-math-component="component.name"
              @click="math.select(component.name)"
            >
              <span class="truncate text-sm">{{ component.name }}</span>
              <span class="flex-1" />
              <Badge
                v-if="component.overridden"
                variant="outline"
                :class="WARNING_BADGE"
                data-testid="math-overridden"
              >
                override
              </Badge>
              <Badge
                v-else-if="isUserComponent(component)"
                variant="outline"
                class="shrink-0 border-accent-border px-1 font-normal text-accent-text"
              >
                mine
              </Badge>
            </button>
          </template>

          <StateMessage v-if="!total && math.payload" variant="inline">
            Nothing matches.
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
            <Eyebrow class="mb-0">{{
              math.payload.groups.find((group) => group.key === selected!.group)?.label ??
              selected.group
            }}</Eyebrow>
            <h2 class="text-lg text-foreground">{{ selected.name }}</h2>
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

          <div v-if="equation" class="cg-math" data-testid="math-equation" v-html="equation.html" />
          <StateMessage v-if="equation && hasRenderError(equation)" variant="inline" tone="warning">
            This equation could not be typeset.
          </StateMessage>

          <div
            v-if="selected.uses.length || selected.used_in.length"
            class="flex flex-col gap-1.5"
          >
            <div v-if="selected.uses.length" class="flex flex-wrap items-baseline gap-1">
              <Eyebrow class="mb-0">Uses</Eyebrow>
              <button
                v-for="name in selected.uses"
                :key="name"
                type="button"
                class="rounded-xs px-1 text-sm text-accent-text hover:bg-hover"
                :disabled="!math.componentsByName.has(name)"
                :data-math-ref="name"
                @click="math.select(name)"
              >
                {{ name }}
              </button>
            </div>
            <div
              v-if="selected.used_in.length"
              class="flex flex-wrap items-baseline gap-1"
            >
              <Eyebrow class="mb-0">Used in</Eyebrow>
              <button
                v-for="name in selected.used_in"
                :key="name"
                type="button"
                class="rounded-xs px-1 text-sm text-accent-text hover:bg-hover"
                :disabled="!math.componentsByName.has(name)"
                :data-math-ref="name"
                @click="math.select(name)"
              >
                {{ name }}
              </button>
            </div>
          </div>

          <!-- The YAML is the *cause* of the notation above it, so somebody
               writing math needs both on one screen. -->
          <div v-if="selected.yaml" class="flex flex-col gap-1">
            <Eyebrow class="mb-0">Definition</Eyebrow>
            <pre
              class="overflow-auto rounded-sm border border-border-subtle bg-panel p-2"
              :class="CODE_BLOCK"
            >{{ selected.yaml }}</pre>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
