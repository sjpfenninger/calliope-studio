<script setup lang="ts">
/**
 * The strip at the top of a pane or a card.
 *
 * Two things were conflated before this existed and are now separated by one
 * prop: **chrome strips**, which span a full-height pane and sit on `--cg-panel`,
 * and **card headers**, which sit inside a bordered box on `--cg-surface` and
 * divide with the subtle hairline. The geometry is identical; only the tone
 * differs, so one component covers both rather than two that drift apart.
 *
 * There were seven near-copies of the chrome string and three of the card one,
 * at four heights and with `gap-1`, `gap-1.5`, `gap-2`, `px-1` and `px-2` between
 * them — including two that were byte-identical in different files. `gap` and
 * `px` are fixed here for that reason.
 *
 * The companion rule, which is what actually resolved three sibling chart headers
 * being 28, 28-wrapping and 36px in one file: **a control inside a strip is one
 * size below the strip.** An h-8 strip holds h-6 controls, an h-7 strip holds h-5.
 */
import { computed, type HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = withDefaults(
  defineProps<{
    /** `chrome` spans a pane and sits on the panel tone; `card` divides a box. */
    tone?: "chrome" | "card";
    /**
     * 32px (`lg`) for a primary strip, 28px (`md`) for one nested inside a pane.
     *
     * Named for the height, so that `md` is 28px here and 28px everywhere else.
     * These were `md`/`sm`, one step above what the same words meant on a
     * button — which is how a header ended up holding controls at three sizes.
     */
    size?: "md" | "lg";
    /**
     * Let the strip grow and wrap instead of pinning its height.
     *
     * For a header carrying more controls than fit on one line. Prefer moving
     * the controls somewhere else.
     */
    wrap?: boolean;
    class?: HTMLAttributes["class"];
  }>(),
  { tone: "chrome", size: "lg", wrap: false },
);

const classes = computed(() =>
  cn(
    "flex shrink-0 items-center gap-1.5 px-2",
    props.tone === "chrome"
      ? "border-b border-border bg-panel"
      : "border-b border-border-subtle",
    props.wrap
      ? ["flex-wrap py-1", props.size === "lg" ? "min-h-8" : "min-h-7"]
      : props.size === "lg"
        ? "h-8"
        : "h-7",
    props.class,
  ),
);
</script>

<template>
  <div :class="classes">
    <slot />
  </div>
</template>
