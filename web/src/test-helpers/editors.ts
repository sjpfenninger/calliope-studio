/**
 * Mounting a structured editor the way the app does.
 *
 * Under a `TooltipProvider`, as `App.vue` mounts the whole app: the toolbar,
 * every `FieldRow` and every icon button go through Reka's tooltip, which
 * throws without the provider's context. And on a tab of its own, because the
 * composable's `markDirty`/`markClean` are no-ops without one — a tab id and a
 * path are both `string`, and a made-up id silently marks nothing.
 *
 * The mocked server lives in `editorApi.ts`, which imports nothing from the
 * app; see its docblock for why the two cannot be one file. Re-exported here so
 * a test imports from one place.
 */
import { flushPromises, mount, type MountingOptions, type VueWrapper } from "@vue/test-utils";

type Stubs = NonNullable<NonNullable<MountingOptions<unknown>["global"]>["stubs"]>;
import { h, type Component } from "vue";

import TooltipProvider from "@/components/ui/tooltip/TooltipProvider.vue";
import { Select } from "@/components/ui/select";
import { useConfirmStore } from "@/stores/confirm";
import { useTabsStore } from "@/stores/tabs";

export * from "./editorApi";

export interface MountedEditor {
  host: VueWrapper;
  /** The tab the editor is mounted for, already in front. */
  tabId: string;
  find: (testid: string) => ReturnType<VueWrapper["find"]>;
  findAll: (testid: string) => ReturnType<VueWrapper["findAll"]>;
}

/**
 * Mounts an editor for `section` of `filePath` and waits for its load.
 *
 * The wrapper is not unmounted here: call `enableAutoUnmount(afterEach)` in the
 * test file. Left mounted, an editor's window listener keeps answering Cmd+S
 * from the *next* test — its tab id is deterministic, so the gate that limits
 * the shortcut to the tab in front lets it through — and writes.
 */
export async function mountEditor(
  component: Component,
  spec: {
    section: string;
    filePath?: string;
    versionId?: string;
    entryName?: string;
    /** Further shells to stub past `teleport`, for a pane Reka cannot measure here. */
    stubs?: Stubs;
    /**
     * Mount into the document, for a test about focus: an element outside the
     * document cannot become `activeElement`, so `focus()` on it is a no-op
     * that no assertion can see.
     */
    attach?: boolean;
  },
): Promise<MountedEditor> {
  const filePath = spec.filePath ?? "model.yaml";
  const versionId = spec.versionId ?? "v1";
  const tabs = useTabsStore();
  const tabId = spec.entryName
    ? tabs.openEntry(spec.section, filePath, spec.entryName)
    : tabs.openSection(spec.section, filePath);
  const host = mount(TooltipProvider, {
    slots: {
      default: () =>
        h(component, { versionId, filePath, tabId, entryName: spec.entryName ?? null }),
    },
    global: { stubs: { teleport: true, ...(spec.stubs ?? {}) } },
    ...(spec.attach ? { attachTo: document.body } : {}),
  });
  await flushPromises();
  return {
    host,
    tabId,
    find: (testid) => host.find(`[data-testid="${testid}"]`),
    findAll: (testid) => host.findAll(`[data-testid="${testid}"]`),
  };
}

/** Cmd+S, as the composable's window listener sees it. */
export function pressSave(): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true }));
}

/**
 * Saves a form through the keyboard, which is the route that still writes a
 * *clean* form. The toolbar's button is disabled while there is nothing to
 * save, so a test about what an untouched load writes back — the config
 * editor's migrations, say — has to go this way.
 */
export async function saveByKeyboard(mounted: MountedEditor): Promise<void> {
  useTabsStore().activate(mounted.tabId);
  pressSave();
  await flushPromises();
}

/** A frame, which is when a freshly added row's field takes focus. */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Picks a value in one of the app's `Select`s, found by its trigger's testid.
 *
 * Reka's list opens on pointer events a headless DOM does not deliver, so the
 * choice is made the way the list would make it: by emitting the root's own
 * `update:modelValue`. `null` chooses the blank row, which the editors spell
 * as a sentinel because Reka refuses `""` as an item value.
 */
export async function chooseOption(
  mounted: MountedEditor,
  testid: string,
  value: string | null,
): Promise<void> {
  const select = mounted.host
    .findAllComponents(Select)
    .find((candidate) => candidate.find(`[data-testid="${testid}"]`).exists());
  if (!select) throw new Error(`No select whose trigger is ${testid}`);
  select.vm.$emit("update:modelValue", value ?? "__none__");
  await flushPromises();
}

/** The names of the rows on screen, in order. */
export function rowNames(mounted: MountedEditor, testid = "entry-row"): string[] {
  return mounted.findAll(testid).map((row) => row.attributes("data-name") ?? "");
}

/**
 * Answers the confirmation an entry-level removal now asks, so a test that
 * clicks `entry-remove` can say which way. Removing a technology, node, link,
 * data table, scenario or override takes everything the entry owns with it, and
 * that is the line above which the editors confirm and below which — a single
 * parameter row — they do not.
 */
export async function answerConfirm(accept: boolean): Promise<void> {
  const confirm = useConfirmStore();
  if (!confirm.request) throw new Error("No confirmation is pending");
  confirm.answer(accept);
  await flushPromises();
}
