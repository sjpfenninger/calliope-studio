import { ref } from "vue";
import { defineStore } from "pinia";

import { getTemplates } from "../api/versions";

/**
 * The model's templates, each already resolved against the ones it inherits from.
 *
 * One store rather than three copies of "fetch `?section=templates` from every file
 * the tree mentions and merge them", which is what the techs, links and nodes
 * editors each did. That merge was also only one hop deep: a template inheriting a
 * template — `power_lines → interest_rate_setter` in `examples/model_nld-NUTS3-v1`
 * — showed half of what an entry actually inherits, and made the editors' own
 * "is this a transmission tech" test disagree with Calliope's.
 *
 * Resolution happens on the server through Calliope's own `TemplateSolver`, so this
 * is a fetch and a cache, not a computation.
 */
export const useTemplatesStore = defineStore("templates", () => {
  const templates = ref<Record<string, Record<string, any>>>({});
  const loadedVersionId = ref<string | null>(null);

  async function load(versionId: string): Promise<void> {
    if (loadedVersionId.value === versionId) return;
    try {
      templates.value = await getTemplates(versionId);
      loadedVersionId.value = versionId;
    } catch (caught) {
      // A model whose templates cannot be read is one being written. The editors
      // fall back to showing no inherited fields, which is what they did before —
      // but the reason goes to the console rather than nowhere, because a
      // template that silently stops resolving reads as a field the entry lost.
      templates.value = {};
      console.error("The model's templates could not be resolved.", caught);
    }
  }

  async function refresh(versionId: string): Promise<void> {
    loadedVersionId.value = null;
    await load(versionId);
  }

  return { templates, load, refresh };
});
