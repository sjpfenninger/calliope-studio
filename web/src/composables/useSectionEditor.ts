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
 *
 * Three guards on `save()` are the ones that used to be missing, and each is a
 * way a file was emptied or an edit silently lost:
 *
 * - **Nothing loaded, nothing saved.** After a failed load `build()` ran over
 *   an empty form and wrote `{}` — and every section write deletes the keys
 *   absent from its payload, so that was the whole section gone.
 * - **Only the pane on screen answers Cmd+S.** The listener is on `window` and
 *   every dirty pane stays mounted, so one keystroke used to save all of them
 *   — two of which could be Techs and Links racing over one file.
 * - **An edit typed during the write stays dirty.** `markClean` landed after
 *   the await whatever had been typed meanwhile, and that edit was then never
 *   saved by anything.
 */
import { computed, onMounted, onUnmounted, nextTick, ref, toValue, watch } from "vue";
import type { MaybeRefOrGetter } from "vue";

import { errorDetail, isConflict } from "@/api/errors";
import {
  putYamlSection,
  readYamlSection,
  type Revised,
  type SectionData,
} from "@/api/versions";
import { useConfirmStore, type ConfirmRequest } from "@/stores/confirm";
import { useSectionDataStore } from "@/stores/sectionData";
import { isEditableTab, useTabsStore } from "@/stores/tabs";

/**
 * The question asked before an *entry* is removed: a technology, a node, a
 * link, a data table, a scenario, an override.
 *
 * Those own things — parameters, settings, a list of overrides — and taking
 * one out of the form takes everything it owns with it, which is the line
 * above which the editors confirm and below which (one parameter row, one
 * setting, one key) they do not. Un-registering a math file, which leaves the
 * file on disk, asked first; removing a technology with forty parameters did
 * not. Written once so the seven editors cannot phrase it seven ways.
 *
 * `owns` is a phrase counting what goes with it — "12 parameters", "3
 * parameters and 2 technologies" — or empty for an entry that sets nothing.
 */
export function removalRequest(name: string, owns: string): ConfirmRequest {
  const what = owns ? `It takes ${owns} with it. ` : "";
  return {
    title: `Remove ${name}?`,
    message: `${what}Nothing is written until you save.`,
    confirmLabel: "Remove",
    destructive: true,
  };
}

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
   * `{new: old}` for every entry renamed since the load, sent beside the
   * section so the server moves the key in place. Without it a rename is a
   * deletion and an addition: the entry lands at the end of the file and its
   * comments go with the deleted key. See `lib/entries.ts::renamesFor`.
   */
  renames?: () => Record<string, string>;
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
   * templates, the map. Runs outside the save's own try/catch: the write is on
   * disk by the time it fires, so a refresh that throws is logged rather than
   * reported as a failed save.
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
    read: (versionId: string, path: string) => Promise<Revised<SectionData>>;
    write: (
      versionId: string,
      path: string,
      data: SectionData,
      revision: string | null,
      renames: Record<string, string>,
    ) => Promise<string | null>;
  };
}

export function useSectionEditor(options: SectionEditorOptions) {
  const tabs = useTabsStore();
  const cache = useSectionDataStore();
  const confirm = useConfirmStore();

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
  /**
   * The save was refused because the file changed on disk since it was loaded
   * here. The fix is a reload, not a retry, which is why it is its own flag.
   */
  const conflict = ref(false);

  const read =
    options.transport?.read ??
    ((versionId: string, path: string) =>
      readYamlSection(versionId, path, options.section));
  const write =
    options.transport?.write ??
    ((
      versionId: string,
      path: string,
      data: SectionData,
      revision: string | null,
      renames: Record<string, string>,
    ) => putYamlSection(versionId, path, options.section, data, revision, renames));

  const ids = () => ({
    versionId: toValue(options.versionId),
    path: toValue(options.filePath),
    tabId: toValue(options.tabId),
  });

  /**
   * Whether another buffer holds unsaved changes to this file.
   *
   * One buffer per file may be dirty — see `tabs.dirtyOwner`. While somebody
   * else holds this file the form is shown but disabled, and `save` refuses.
   */
  const locked = computed(() => !tabs.canEdit(toValue(options.tabId), "form"));
  const lockOwner = computed(() =>
    locked.value ? tabs.dirtyOwner(toValue(options.filePath)) : null,
  );

  // Guards overlapping loads: `filePath` can change again while a read is in
  // flight, and only the newest request may apply its data or mark the tab
  // clean — a stale one landing last would put the previous file's section
  // into the form. Same pattern as `validation.ts` and `math.ts`.
  let generation = 0;

  async function load(): Promise<void> {
    const mine = ++generation;
    const { versionId, path, tabId } = ids();
    isLoading.value = true;
    error.value = null;
    let applied = false;
    try {
      // Read-through, for every section rather than three of them. The cache is
      // populated on save and cleared by MonacoYamlEditor whenever the raw file
      // is written, so the two routes to a section cannot disagree.
      let data = cache.get(versionId, path, options.section);
      if (data === null) {
        const fresh = await read(versionId, path);
        data = fresh.data;
        cache.set(versionId, path, options.section, data);
        cache.setRevision(path, fresh.revision);
      }
      if (mine !== generation) return;
      await options.apply(data);
      applied = true;
    } catch (caught) {
      if (mine !== generation) return;
      error.value = errorDetail(caught, `Failed to load ${options.label}.`);
    } finally {
      if (mine === generation) {
        isLoading.value = false;
        // The dirty watchers in some of these editors are post-flush, so they
        // fire once *after* `isLoading` goes false, with the values `apply`
        // just wrote. Without the tick, opening a tab gave it an
        // unsaved-changes dot.
        await nextTick();
        // Only the form's own flag, and only when the form really was rebuilt:
        // a failed load has changed nothing, and the raw buffer of the same tab
        // may be holding the user's edits — clearing everything here is how a
        // dirty Monaco buffer came to close without asking.
        if (applied) tabs.markClean(tabId, "form");
      }
    }
  }

  /** Counts edits, so a save can tell whether one landed while it was writing. */
  let edits = 0;

  async function save(): Promise<void> {
    // Not re-entrant. Holding Cmd/Ctrl+S interleaved two saves: the second
    // `build()` ran against a baseline the first `after()` had not replaced
    // yet, two PUTs went out for one file, and `markClean` landed while a write
    // was still in flight — so a failure of the *second* left the tab clean over
    // whichever write happened to land last.
    if (isSaving.value) return;
    if (isLoading.value || error.value) {
      saveError.value = `Nothing is loaded here to save — ${options.label} could not be read.`;
      return;
    }
    if (locked.value) {
      saveError.value = `${lockOwner.value?.title ?? "Another tab"} holds unsaved changes to this file.`;
      return;
    }
    const { versionId, path, tabId } = ids();
    isSaving.value = true;
    saveError.value = null;
    conflict.value = false;
    let written: SectionData | null = null;
    let saved = false;
    const editsAtBuild = edits;
    try {
      await options.beforeWrite?.();
      if (options.shouldWrite?.() ?? true) {
        written = options.build();
        const revision = await write(
          versionId,
          path,
          written,
          cache.revisionOf(path),
          options.renames?.() ?? {},
        );
        cache.set(versionId, path, options.section, written);
        cache.setRevision(path, revision);
        cache.noteFileWritten(path);
        seenRevision = cache.fileRevisions.get(path) ?? 0;
      }
      // An edit made while the write was in flight is not on disk; leaving the
      // tab dirty is what keeps it from being closed and lost.
      if (edits === editsAtBuild) tabs.markClean(tabId, "form");
      saved = true;
    } catch (caught) {
      // The tab stays dirty: something did not land.
      conflict.value = isConflict(caught);
      saveError.value = errorDetail(caught, `Failed to save ${options.label}.`);
    } finally {
      isSaving.value = false;
    }
    if (!saved) return;
    // Outside the try above: the write has landed and the tab is clean, so a
    // refresh hook that throws must not be reported as a failed save. The
    // hooks swallow their own failures today; this holds whether they do.
    try {
      await options.after?.(written);
    } catch (caught) {
      console.error(`Refresh after saving ${options.label} failed:`, caught);
    }
  }

  /**
   * Throws the form's edits away and re-reads the file, after asking.
   *
   * For the 409: the file changed under this form, and the user has to choose
   * between their edits here and whatever landed on disk. Nothing chooses for
   * them.
   */
  async function reload(): Promise<void> {
    const ok = await confirm.ask({
      title: `Reload ${options.label} from disk?`,
      message: "The unsaved edits in this form will be lost.",
      confirmLabel: "Reload",
      destructive: true,
    });
    if (!ok) return;
    const { versionId, path } = ids();
    saveError.value = null;
    conflict.value = false;
    cache.invalidate(versionId, path, options.section);
    await load();
  }

  function markDirty(): void {
    edits += 1;
    tabs.markDirty(toValue(options.tabId), "form");
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!(event.metaKey || event.ctrlKey) || event.key !== "s") return;
    // Only the pane on screen. The listener is on `window` and every dirty
    // pane stays mounted, so without this one keystroke saved all of them.
    const tabId = toValue(options.tabId);
    if (tabs.activeId !== tabId) return;
    const tab = tabs.get(tabId);
    if ((tab?.kind === "section" || tab?.kind === "entry") && tab.editorMode !== "structured") {
      return;
    }
    event.preventDefault();
    // Most fields in these forms commit on `change`, which a keystroke never
    // fires: Cmd+S read the value from before the one on screen, wrote it, and
    // then marked the tab clean over an edit the box was still showing.
    // Blurring first fires `change` synchronously, so `build()` sees it.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    save();
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

  /**
   * Adopt a write to this file that came from somewhere else.
   *
   * This used to come for free, and badly: `TabBody` mounted only the *active*
   * structured editor, so a `config` write from the math panel or a raw Cmd+S
   * in Monaco was picked up by the remount — at the cost of destroying any
   * unsaved edits in every other form. The panes are kept alive now, so the
   * same reverse channel `MonacoYamlEditor` watches carries it here instead.
   *
   * **A dirty form is left alone.** Its buffer is the user's unsaved work, and
   * discarding that silently is the bug the whole change is about. Under the
   * one-buffer-per-file rule this form is dirty only when it is the writer.
   */
  let seenRevision = cache.fileRevisions.get(toValue(options.filePath)) ?? 0;
  let seenPath = toValue(options.filePath);
  watch(
    () => cache.fileRevisions.get(toValue(options.filePath)) ?? 0,
    (revision) => {
      // A *different* file's revision is not a write to this one. The watcher
      // above already reloads on a path change, so without this a section-tab
      // switch made two GETs for one section — and the second raced the first.
      const path = toValue(options.filePath);
      if (path !== seenPath) {
        seenPath = path;
        seenRevision = revision;
        return;
      }
      if (revision === seenRevision) return;
      seenRevision = revision;
      const tab = tabs.get(toValue(options.tabId));
      if (tab && isEditableTab(tab) && tab.dirtySources.has("form")) return;
      load();
    },
  );

  return {
    isLoading,
    isSaving,
    error,
    saveError,
    conflict,
    locked,
    lockOwner,
    load,
    save,
    reload,
    markDirty,
  };
}
