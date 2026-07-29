<script setup lang="ts">
/**
 * What a file that is not text looks like.
 *
 * Everything non-CSV used to go to Monaco, so a `.png` opened as a screenful of
 * replacement characters — and, worse, as an *editable* one: the tab passed
 * `isEditableTab`, so Ctrl/Cmd+S wrote that transcription back over the image.
 * The guard for that is in the store, not here; this is only the half the user
 * sees.
 *
 * An image is fetched by the browser as an ordinary `<img src>` rather than
 * through axios into a blob URL: the bytes never need to be in JavaScript, and
 * a blob would cost a copy and lose the browser's own caching. The URL is still
 * minted in `api/versions.ts`, so the route is written once.
 */
import { computed, ref, watch } from "vue";
import { FileArchive } from "@lucide/vue";

import StateMessage from "@/components/app/StateMessage.vue";
import { rawFileUrl } from "@/api/versions";
import { formatBytes } from "@/lib/format";
import { useVersionStore } from "@/stores/version";

const props = defineProps<{
  versionId: string;
  path: string;
  /** `image` is attempted; anything else is reported, not rendered. */
  fileType: "image" | "binary";
}>();

const version = useVersionStore();

/**
 * An image that will not decode falls back to the binary message.
 *
 * The extension is only a claim — a `.png` that is really a spreadsheet, or a
 * truncated download, would otherwise show the browser's broken-image glyph and
 * nothing else.
 */
const failed = ref(false);
watch(() => props.path, () => (failed.value = false));

const src = computed(() => rawFileUrl(props.versionId, props.path));
const name = computed(() => props.path.split("/").pop() ?? props.path);

const size = computed(() => {
  const bytes = version.sizeOf(props.path);
  return bytes === null ? null : formatBytes(bytes);
});

const showImage = computed(() => props.fileType === "image" && !failed.value);
</script>

<template>
  <div class="grid place-items-center overflow-auto bg-surface p-6">
    <img
      v-if="showImage"
      :src="src"
      :alt="name"
      data-testid="file-image"
      class="max-h-full max-w-full object-contain"
      @error="failed = true"
    />

    <StateMessage
      v-else
      variant="block"
      :icon="FileArchive"
      :title="name"
      data-testid="file-binary"
    >
      Binary file — cannot display{{ size ? ` (${size})` : "" }}.
    </StateMessage>
  </div>
</template>
