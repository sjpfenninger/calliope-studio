<script setup lang="ts">
/**
 * What the two versions *mean*, according to Calliope.
 *
 * The file view says a line changed; this says the technology it belongs to now
 * has a different capacity — which is the question somebody comparing two runs
 * actually has. Every number here came out of a resolved model, so templates,
 * data tables, overrides and `active:` are already applied.
 *
 * **Values are shown unscaled**, labelled with the generalised quantity
 * Calliope declares. The number beside the label has to be the one in the YAML
 * the Files view shows and the user will go and edit; scaling it by whatever
 * the charts are set to would make the two halves of one tab disagree by a
 * factor, with nothing on screen to explain it. An unreadable or ambiguous
 * declaration — six parameters declare three alternatives at once — gets no
 * label rather than a guessed one.
 */
import { computed } from "vue";

import type { CompareModel, DiffChange, DiffEntity } from "@/api/compare";
import Eyebrow from "@/components/app/Eyebrow.vue";
import StateMessage from "@/components/app/StateMessage.vue";
import { Badge } from "@/components/ui/badge";
import { compareStatus } from "@/lib/compareStatus";
import { formatCompact, formatCount } from "@/lib/format";
import {
  ADDED_BADGE,
  CODE_BLOCK,
  IDENTIFIER,
  NEUTRAL_BADGE,
  REMOVED_BADGE,
  WARNING_BADGE,
} from "@/lib/formClasses";
import { resolveUnit } from "@/lib/units";

const props = defineProps<{
  payload: CompareModel | null;
  loading: boolean;
  error: string | null;
}>();

/** In display order, and each with the heading a modeller would use. */
const GROUPS: Array<{ kind: DiffEntity["kind"]; label: string }> = [
  { kind: "tech", label: "Technologies" },
  { kind: "link", label: "Links" },
  { kind: "node", label: "Nodes" },
  { kind: "carrier", label: "Carriers" },
  { kind: "model", label: "Model" },
];

const BADGE: Record<DiffEntity["status"], string> = {
  added: ADDED_BADGE,
  removed: REMOVED_BADGE,
  changed: WARNING_BADGE,
};

const diff = computed(() => props.payload?.diff ?? null);

const status = computed(() =>
  props.payload
    ? compareStatus(
        props.payload.a,
        props.payload.b,
        props.payload.pending,
        props.payload.reason,
      )
    : null,
);

const groups = computed(() =>
  GROUPS.map((group) => ({
    ...group,
    entities: (diff.value?.entities ?? []).filter(
      (entity) => entity.kind === group.kind,
    ),
  })).filter((group) => group.entities.length),
);

/** No prefs: the declarations normalise, and nothing is multiplied. */
function unitLabel(raw: string): string {
  return resolveUnit(raw, {}).label;
}

/**
 * A value exactly as it is, never compacted.
 *
 * `formatCompact` would draw 12345 as "12.3K", and this number's whole job is
 * to be recognisable as the one in the YAML the Files view shows two clicks
 * away — a rounded one sends somebody searching their file for a value that is
 * not in it. Sums over a time series are a different thing and do use the
 * compact form: nobody matches those against a line in a file.
 */
function valueText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.join(", ") || "—";
  return String(value);
}

/**
 * A time-varying parameter, in a line.
 *
 * Sums are compacted where single values are not: nobody matches a sum over
 * 8,760 timesteps against a line in a file, which is the reason the values
 * above stay exact.
 */
function seriesText(change: DiffChange): string {
  const series = change.series!;
  const sums = [series.before_sum, series.after_sum].filter(
    (sum): sum is number => sum != null,
  );
  const total = formatCount(series.total, "timestep");

  // A listing rather than a change: one side, so there is nothing to compare.
  if (series.changed === undefined) {
    return sums.length ? `${total} · Σ ${formatCompact(sums[0])}` : total;
  }
  const counted = `${series.changed} of ${total} changed`;
  return sums.length === 2
    ? `${counted} · Σ ${formatCompact(sums[0])} → ${formatCompact(sums[1])}`
    : counted;
}

/**
 * The one value an added or removed entity's row carries.
 *
 * Which side it is on is a property of the *entity*, not of the row: an added
 * one describes itself with `after` and a removed one with `before`.
 */
function detailText(status: DiffEntity["status"], change: DiffChange): string {
  return valueText(status === "removed" ? change.before : change.after);
}
</script>

<template>
  <div class="min-h-0 flex-1 overflow-auto" data-testid="compare-model">
    <StateMessage v-if="error" variant="fill" tone="danger">{{ error }}</StateMessage>
    <StateMessage v-else-if="loading && !payload" variant="fill" loading>
      Comparing the two models…
    </StateMessage>
    <StateMessage
      v-else-if="status"
      variant="fill"
      :tone="status.tone === 'info' ? 'muted' : status.tone"
      :loading="status.loading"
      data-testid="compare-model-status"
    >
      {{ status.text }}
      <span v-if="status.detail" :class="CODE_BLOCK" class="mt-2 block text-left">{{
        status.detail
      }}</span>
    </StateMessage>
    <StateMessage
      v-else-if="diff?.empty"
      variant="fill"
      data-testid="compare-model-empty"
      title="No differences"
    >
      Calliope reads these two versions of the model as exactly the same.
    </StateMessage>

    <div v-else-if="diff" class="flex flex-col gap-3 p-2">
      <!-- Stated once. A shorter time window changes every series in the
           model, and saying so per series would bury everything else. -->
      <section v-if="diff.dims.length" data-testid="compare-dims">
        <Eyebrow>Dimensions</Eyebrow>
        <div
          v-for="row in diff.dims"
          :key="row.dim"
          class="flex items-baseline gap-1.5 border-b border-border-subtle py-1"
        >
          <span :class="IDENTIFIER">{{ row.dim }}</span>
          <span class="text-sm">{{ row.before }} → {{ row.after }}</span>
          <span v-if="row.added?.length" class="text-2xs text-success-text">
            + {{ row.added.join(", ") }}
          </span>
          <span v-if="row.removed?.length" class="text-2xs text-danger-text">
            − {{ row.removed.join(", ") }}
          </span>
          <span v-if="row.range?.after" class="text-2xs text-text-muted">
            {{ row.range.after[0] }} → {{ row.range.after[1] }}
          </span>
        </div>
      </section>

      <section v-for="group in groups" :key="group.kind">
        <Eyebrow>{{ group.label }}</Eyebrow>
        <div
          v-for="entity in group.entities"
          :key="entity.name"
          class="border-b border-border-subtle py-1"
          data-testid="compare-entity"
          :data-kind="entity.kind"
          :data-name="entity.name"
          :data-status="entity.status"
        >
          <div class="flex items-baseline gap-1.5">
            <span class="text-sm">{{ entity.name }}</span>
            <Badge variant="outline" :class="BADGE[entity.status]">
              {{ entity.status }}
            </Badge>
          </div>

          <p
            v-if="entity.status !== 'changed' && entity.changes.length"
            class="pl-3 pt-0.5 text-2xs text-text-muted"
          >
            {{ entity.status === "added" ? "Defined as" : "Was defined as" }}
          </p>

          <div
            v-for="(change, index) in entity.changes"
            :key="`${change.param}-${index}`"
            class="flex flex-wrap items-baseline gap-1.5 pl-3 pt-0.5"
            data-testid="compare-change"
            :data-param="change.param"
          >
            <span :class="IDENTIFIER">{{ change.param }}</span>
            <Badge
              v-for="(coord, dim) in change.where"
              :key="dim"
              variant="outline"
              :class="NEUTRAL_BADGE"
            >
              {{ dim }}: {{ coord }}
            </Badge>

            <span v-if="change.series" class="text-sm text-text-muted">
              {{ seriesText(change) }}
            </span>
            <!-- An added or removed entity's rows are a listing of what it is,
                 so there is one value and no arrow: "→ 10000" would invite the
                 question of what it was before, which is nothing. -->
            <span
              v-else-if="entity.status !== 'changed'"
              class="text-sm"
              :class="entity.status === 'removed' ? 'text-danger-text' : 'text-success-text'"
            >
              {{ detailText(entity.status, change) }}
            </span>
            <span v-else class="text-sm">
              <span class="text-danger-text">{{ valueText(change.before) }}</span>
              →
              <span class="text-success-text">{{ valueText(change.after) }}</span>
            </span>

            <span v-if="unitLabel(change.unit)" class="text-2xs text-text-muted">
              {{ unitLabel(change.unit) }}
            </span>
          </div>

          <p v-if="entity.truncated" class="pl-3 text-2xs text-text-muted">
            and {{ formatCount(entity.truncated, "further change") }}
          </p>
        </div>
      </section>

      <section v-if="diff.config.length" data-testid="compare-config">
        <Eyebrow>Config</Eyebrow>
        <div
          v-for="row in diff.config"
          :key="row.path"
          class="flex flex-wrap items-baseline gap-1.5 border-b border-border-subtle py-1"
          data-testid="compare-change"
          :data-param="row.path"
        >
          <span :class="IDENTIFIER">{{ row.path }}</span>
          <span class="text-sm">
            <span class="text-danger-text">{{ valueText(row.before) }}</span>
            →
            <span class="text-success-text">{{ valueText(row.after) }}</span>
          </span>
        </div>
      </section>
    </div>
  </div>
</template>
