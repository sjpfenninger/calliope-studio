/**
 * The machinery every structured editor was carrying its own copy of.
 *
 * Seven editors — config, data tables, nodes, techs, links, overrides,
 * scenarios — each independently declared the same `isLoading`/`isSaving`/
 * `error` triad, the same load-catch-finally, the same save, the same
 * `markDirty`/`markClean` calls, a **verbatim identical** Cmd/Ctrl+S handler,
 * the same mount/unmount registration and the same `watch(filePath, load)`.
 *
 * The interesting part is what the seven copies *disagreed* about, because that
 * is where the bugs were:
 *
 * - **Five had no `catch` in `save()`**, so a rejected PUT was an unhandled
 *   rejection and the user was told nothing.
 * - **One never removed its keydown listener**, leaking one per config tab
 *   opened and then saving stale state on any later Cmd+S.
 * - **Three of seven consulted the `sectionData` cache**, so Monaco's
 *   invalidation on a raw save meant something for half the sections and
 *   nothing for the others.
 * - **Four never called `markClean` after loading**, so whether merely opening
 *   a tab could mark it dirty depended on which editor it was.
 * - One swallowed a failed section read entirely and rendered an empty form.
 *
 * None of those is a design decision anyone made seven times. They are what
 * seven copies of the same forty lines become.
 *
 * The caller supplies the two halves that are genuinely its own — `apply`, which
 * turns the loaded section into component state, and `build`, which turns it
 * back — plus optional hooks for the things exactly one editor needs. Both are
 * allowed to be async: LinksEditor and TechsEditor cannot decide which
 * technologies are links until the templates have resolved, so `apply` awaits
 * that itself rather than the composable growing a phase for it.
 */
import { onMounted, onUnmounted, nextTick, ref, toValue, watch } from "vue";
import type { MaybeRefOrGetter } from "vue";

import { errorDetail } from "@/api/errors";
import { getYamlSection, putYamlSection, type SectionData } from "@/api/versions";
import { useSectionDataStore } from "@/stores/sectionData";
import { useTabsStore } from "@/stores/tabs";

export interface SectionEditorOptions {
  versionId: MaybeRefOrGetter<string>;
  filePath: MaybeRefOrGetter<string>;
  tabId: MaybeRefOrGetter<string>;
  /** The YAML section this editor owns, and the cache key it is stored under. */
  section: string;
  /** Names the thing in a failure message: "nodes", "transmission technologies". */
  label: string;
  /** Loaded section → component state. May await whatever else it needs first. */
  apply: (data: SectionData) => void | Promise<void>;
  /** Component state → the section to write. */
  build: () => SectionData;
  /**
   * Written before the section is. For the one editor that owns a CSV as well,
   * where the cell edits are the expensive half and so go first.
   */
  beforeWrite?: () => void | Promise<void>;
  /**
   * Whether the section itself needs writing at all.
   *
   * Defaults to true. DataTablesEditor answers `formDirty`, so that saving an
   * edited grid does not also rewrite a YAML section nobody touched.
   */
  shouldWrite?: () => boolean;
  /**
   * Derived state to refresh once the write has landed — the component tree, the
   * templates, the map. These swallow their own failures by design, which is why
   * they can sit inside the same `try` without a successful write ever being
   * reported as a failed one.
   *
   * Receives what was actually written, or null when `shouldWrite` declined.
   * The editors that share a section need it: having written the merged whole,
   * they have to adopt it as their new baseline or the next save merges against
   * a stale one.
   */
  after?: (written: SectionData | null) => void | Promise<void>;
  /**
   * Read and write through the endpoint that is not `yaml-section`.
   *
   * Overrides are served separately, because an override is an arbitrary partial
   * model and the server applies each path against the structure already in the
   * file. Only the transport differs; everything else here is identical.
   */
  transport?: {
    read: (versionId: string, path: string) => Promise<SectionData>;
    write: (versionId: string, path: string, data: SectionData) => Promise<void>;
  };
}

export function useSectionEditor(options: SectionEditorOptions) {
  const tabs = useTabsStore();
  const cache = useSectionDataStore();

  const isLoading = ref(true);
  const isSaving = ref(false);
  /** A load failure: there is nothing to show. */
  const error = ref<string | null>(null);
  /**
   * A save failure: there *is* something to show, and it is the user's unsaved
   * work — so it must never be reported through `error`, which the editors
   * render in place of the form.
   */
  const saveError = ref<string | null>(null);

  const read =
    options.transport?.read ??
    ((versionId: string, path: string) =>
      getYamlSection(versionId, path, options.section));
  const write =
    options.transport?.write ??
    ((versionId: string, path: string, data: SectionData) =>
      putYamlSection(versionId, path, options.section, data));

  const ids = () => ({
    versionId: toValue(options.versionId),
    path: toValue(options.filePath),
    tabId: toValue(options.tabId),
  });

  async function load(): Promise<void> {
    const { versionId, path, tabId } = ids();
    isLoading.value = true;
    error.value = null;
    try {
      // Read-through, for every section rather than three of them. The cache is
      // populated on save and cleared by MonacoYamlEditor whenever the raw file
      // is written, so the two routes to a section cannot disagree.
      let data = cache.get(versionId, path, options.section);
      if (data === null) {
        data = await read(versionId, path);
        cache.set(versionId, path, options.section, data);
      }
      await options.apply(data);
    } catch (caught) {
      error.value = errorDetail(caught, `Failed to load ${options.label}.`);
    } finally {
      isLoading.value = false;
      // The dirty watchers in some of these editors are post-flush, so they fire
      // once *after* `isLoading` goes false, with the values `apply` just wrote.
      // Without the tick, opening a tab gave it an unsaved-changes dot.
      await nextTick();
      tabs.markClean(tabId);
    }
  }

  async function save(): Promise<void> {
    const { versionId, path, tabId } = ids();
    isSaving.value = true;
    saveError.value = null;
    try {
      await options.beforeWrite?.();
      let written: SectionData | null = null;
      if (options.shouldWrite?.() ?? true) {
        written = options.build();
        await write(versionId, path, written);
        cache.set(versionId, path, options.section, written);
      }
      tabs.markClean(tabId);
      await options.after?.(written);
    } catch (caught) {
      // The tab stays dirty: something did not land.
      saveError.value = errorDetail(caught, `Failed to save ${options.label}.`);
    } finally {
      isSaving.value = false;
    }
  }

  function markDirty(): void {
    tabs.markDirty(toValue(options.tabId));
  }

  function onKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key === "s") {
      event.preventDefault();
      save();
    }
  }

  onMounted(() => {
    window.addEventListener("keydown", onKeydown);
    load();
  });

  // The listener is on `window`, so it outlives the component. ConfigEditor was
  // the one editor that never removed it: every config tab opened left another
  // behind, and afterwards Cmd+S anywhere in the app saved that instance's stale
  // state over whatever was live.
  onUnmounted(() => window.removeEventListener("keydown", onKeydown));

  watch(() => toValue(options.filePath), load);

  return { isLoading, isSaving, error, saveError, load, save, markDirty };
}
