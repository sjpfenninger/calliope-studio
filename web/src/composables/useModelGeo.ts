import { onMounted, ref, watch, type Ref } from "vue";

import client from "../api/client";
import type { GeoPayload } from "../lib/mapGeo";

/**
 * The saved geography of a model definition.
 *
 * What the editors get from this is everything they do *not* hold themselves: the
 * nodes and links defined in files this editor never loaded, and the technology
 * colours. Live geometry comes from `lib/mapGeo`'s `buildGeo` over the editor's
 * own entries, because the point of an editing map is to show what has not been
 * saved yet.
 *
 * `error` is exposed rather than swallowed. The previous version turned any
 * failure into `geo = null`, which is indistinguishable from a model with no
 * geography — so a 500 looked exactly like an empty map and said nothing.
 */
export function useModelGeo(versionId: Ref<string>) {
  const geo = ref<GeoPayload | null>(null);
  const error = ref<string | null>(null);

  async function reload() {
    error.value = null;
    try {
      const response = await client.get<GeoPayload>(
        `/api/versions/${versionId.value}/geo/`,
      );
      geo.value = response.data;
    } catch (caught: any) {
      geo.value = null;
      error.value = caught?.response?.data?.detail ?? "Could not read the model's geography.";
    }
  }

  onMounted(reload);
  watch(versionId, reload);

  return { geo, error, reload };
}
