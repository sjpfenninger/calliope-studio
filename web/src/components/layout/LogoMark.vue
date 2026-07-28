<script setup lang="ts">
/**
 * The wordmark's glyph: Calliope's campfire, sat inside an app window.
 *
 * The same geometry as `public/favicon.svg`, drawn through the tokens instead of
 * literal colours — a favicon renders outside the page's CSS context, so it has
 * to hardcode; anything inside the app should not. Keep the two in step.
 *
 * The crossed logs of the original callio.pe mark are dropped: they turn to mush
 * below ~24px, and the flame shell plus the inner tongue is what carries it.
 */
withDefaults(defineProps<{ class?: string }>(), { class: "size-4" });
</script>

<template>
  <svg
    viewBox="0 0 32 32"
    role="img"
    aria-label="Calliope Studio"
    :class="$props.class"
  >
    <rect x="2" y="4" width="28" height="24" rx="5" fill="var(--cg-accent)" />
    <path
      d="M2.6 10.5h26.8"
      stroke="var(--cg-accent-on)"
      stroke-opacity="0.3"
      stroke-width="1"
    />
    <circle cx="5.5" cy="7.2" r="1" fill="var(--cg-accent-on)" fill-opacity="0.55" />
    <circle cx="8.8" cy="7.2" r="1" fill="var(--cg-accent-on)" fill-opacity="0.55" />
    <circle cx="12.1" cy="7.2" r="1" fill="var(--cg-accent-on)" fill-opacity="0.55" />
    <path
      d="M16 13c2.6 2.1 4.2 4 4.2 6.2A4.2 4.2 0 0 1 16 23.4a4.2 4.2 0 0 1-4.2-4.2c0-2.2 1.6-4.1 4.2-6.2Z"
      fill="var(--cg-accent-on)"
    />
    <path
      d="M16 17.1c1.1 1 1.7 1.8 1.7 2.6a1.7 1.7 0 1 1-3.4 0c0-.8.6-1.6 1.7-2.6Z"
      fill="var(--cg-accent)"
    />
  </svg>
</template>
