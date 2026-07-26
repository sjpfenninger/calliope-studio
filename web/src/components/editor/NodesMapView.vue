<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import client from "../../api/client";
import ModelMap, { type GeoPayload } from "../map/ModelMap.vue";

/**
 * The editor's map, over the shared map component.
 *
 * Geometry now comes from the server rather than being assembled here. The
 * previous version read a `links:` section, which Calliope 0.7 does not have —
 * transmission is defined under `techs:` with `link_from`/`link_to` — so it
 * drew no links at all for any current model.
 */
const props = defineProps<{ versionId: string }>();

const geo = ref<GeoPayload | null>(null);
const selected = ref<string[]>([]);

async function load() {
  try {
    const response = await client.get<GeoPayload>(
      `/api/versions/${props.versionId}/geo/`,
    );
    geo.value = response.data;
  } catch {
    geo.value = null;
  }
}

onMounted(load);
watch(() => props.versionId, load);
</script>

<template>
  <ModelMap v-model:selected="selected" :geo="geo" />
</template>
