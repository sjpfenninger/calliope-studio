/**
 * Stands in for `components/editor/EditorMapPane.vue` under vitest.
 *
 * The real pane renders `ModelMap`, which imports MapLibre's worker through
 * Vite's `?worker&url` suffix — a query the `?worker` alias in `vite.config.ts`
 * does not match, so a test that so much as imports `NodesEditor` or
 * `LinksEditor` fails to *collect*. What those editors are tested for is what
 * they do with the map's events, not whether a canvas draws: this stub takes
 * the same props, declares the same emits so `vm.$emit` can drive the editor,
 * and renders the three slots the editors fill so the toolbar chip and the
 * detail form are reachable in the DOM.
 */
import { defineComponent, h } from "vue";

export default defineComponent({
  name: "EditorMapPaneStub",
  props: {
    geo: { type: Object, default: null },
    selected: { type: Array, default: () => [] },
    missing: { type: Array, default: () => [] },
    error: { type: String, default: null },
    source: { type: String, default: "resolved" },
    resolving: { type: Boolean, default: false },
    draggableNodes: { type: Boolean, default: false },
    interactiveLinks: { type: Boolean, default: false },
    pendingLinkFrom: { type: String, default: null },
  },
  emits: ["update:selected", "nodeClick", "nodeMoved", "linkClick", "showList"],
  setup(_, { slots }) {
    return () =>
      h("div", { "data-testid": "editor-map" }, [
        h("div", { "data-testid": "editor-map-toolbar" }, slots.toolbar?.()),
        slots.default?.(),
        h("div", { "data-testid": "editor-map-detail" }, slots.detail?.()),
      ]);
  },
});
