import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";

import { useSectionDataStore } from "./sectionData";

/**
 * The read-through cache under every structured editor, and the reverse channel
 * beside it.
 *
 * Both halves fail silently by nature. A stale cache entry hands a form the
 * values from before the last save, and the form then writes them back over the
 * newer ones — the user's edit disappears with a clean tab and no error. In the
 * other direction, a structured save rewrites a file Monaco may hold a text
 * model for, and that model is a buffer the next raw Cmd+S writes back: unless
 * the file's revision is bumped, the raw editor silently reverts the structured
 * save. Nothing on screen distinguishes either from "the save did not work".
 */
describe("useSectionDataStore", () => {
  beforeEach(() => setActivePinia(createPinia()));

  describe("the cache", () => {
    it("gives nothing back for a section it has not seen", () => {
      const store = useSectionDataStore();
      expect(store.get("v1", "model.yaml", "techs")).toBeNull();
    });

    it("returns what was put in, by the whole three-part key", () => {
      const store = useSectionDataStore();
      store.set("v1", "model.yaml", "techs", { ccgt: {} });
      expect(store.get("v1", "model.yaml", "techs")).toEqual({ ccgt: {} });
    });

    it("hands back the identical object, not a copy", () => {
      // Worth pinning because it is a hazard as much as a property: a form that
      // mutates what `get` returned has already mutated the cache, so a "cancel"
      // that re-reads gets the edited values. The editors clone before editing;
      // this is why they have to.
      const store = useSectionDataStore();
      const data = { ccgt: { flow_cap_max: 1 } };
      store.set("v1", "model.yaml", "techs", data);
      expect(store.get("v1", "model.yaml", "techs")).toBe(data);
    });

    it("keeps a value set under one model invisible under another", () => {
      // Two models are routinely open, and `techs` in `model.yaml` is a name
      // both of them have. Leaking across would show one model's technologies
      // in the other's editor — and then save them there.
      const store = useSectionDataStore();
      store.set("v1", "model.yaml", "techs", { ccgt: {} });
      expect(store.get("v2", "model.yaml", "techs")).toBeNull();
    });

    it("keeps sections and files apart within one model", () => {
      const store = useSectionDataStore();
      store.set("v1", "model.yaml", "techs", { ccgt: {} });
      expect(store.get("v1", "model.yaml", "nodes")).toBeNull();
      expect(store.get("v1", "other.yaml", "techs")).toBeNull();
    });

    it("forgets one section on invalidate, and leaves its neighbours alone", () => {
      // What a raw save in a virtual tab does: that one section's text was
      // rewritten by hand, and nothing else about the file is known to be stale.
      const store = useSectionDataStore();
      store.set("v1", "model.yaml", "techs", { ccgt: {} });
      store.set("v1", "model.yaml", "nodes", { region1: {} });
      store.invalidate("v1", "model.yaml", "techs");
      expect(store.get("v1", "model.yaml", "techs")).toBeNull();
      expect(store.get("v1", "model.yaml", "nodes")).toEqual({ region1: {} });
    });

    it("forgets every section of a file on invalidateFile", () => {
      // What a Monaco file save does: the whole file was rewritten, so nothing
      // read out of it can be trusted — including sections the editor that
      // saved it never looked at.
      const store = useSectionDataStore();
      store.set("v1", "model.yaml", "techs", { ccgt: {} });
      store.set("v1", "model.yaml", "nodes", { region1: {} });
      store.set("v1", "other.yaml", "techs", { csp: {} });
      store.set("v2", "model.yaml", "techs", { battery: {} });
      store.invalidateFile("v1", "model.yaml");
      expect(store.get("v1", "model.yaml", "techs")).toBeNull();
      expect(store.get("v1", "model.yaml", "nodes")).toBeNull();
      // Another file, and the same file in another model, are untouched.
      expect(store.get("v1", "other.yaml", "techs")).toEqual({ csp: {} });
      expect(store.get("v2", "model.yaml", "techs")).toEqual({ battery: {} });
    });

    it("does not take a file's prefix for the file", () => {
      // The key is joined on `:` and the prefix ends with one, so `model.yaml`
      // and `model.yaml.bak` are different files. Without the separator the
      // first would evict the second's entries as well.
      const store = useSectionDataStore();
      store.set("v1", "model.yaml.bak", "techs", { ccgt: {} });
      store.invalidateFile("v1", "model.yaml");
      expect(store.get("v1", "model.yaml.bak", "techs")).toEqual({ ccgt: {} });
    });

    it("invalidates something that was never there without complaining", () => {
      const store = useSectionDataStore();
      expect(() => store.invalidate("v1", "model.yaml", "techs")).not.toThrow();
      expect(() => store.invalidateFile("v1", "model.yaml")).not.toThrow();
    });
  });

  describe("fileRevisions", () => {
    it("counts a file at nothing until something writes to it", () => {
      // Undefined rather than 0, and the watcher has to cope: a buffer opened
      // before any structured save must not be told it is out of date.
      const store = useSectionDataStore();
      expect(store.fileRevisions.get("model.yaml")).toBeUndefined();
    });

    it("bumps the file's revision on every write", () => {
      // The signal `MonacoYamlEditor` watches. One bump per write, not a
      // boolean: two structured saves in a row have to wake a buffer twice, and
      // a flag that was already set would let the second pass unnoticed.
      const store = useSectionDataStore();
      store.noteFileWritten("model.yaml");
      expect(store.fileRevisions.get("model.yaml")).toBe(1);
      store.noteFileWritten("model.yaml");
      expect(store.fileRevisions.get("model.yaml")).toBe(2);
      // And says nothing about a file nobody wrote.
      expect(store.fileRevisions.get("nodes.yaml")).toBeUndefined();
    });

    it("wakes buffers on a reload request through the very same channel", () => {
      // Deliberately one function: a buffer cannot tell whether the file
      // changed or its own baseline was discarded, and need not — either way
      // what it shows is no longer what it should be showing.
      const store = useSectionDataStore();
      store.noteFileWritten("model.yaml");
      store.requestReload("model.yaml");
      // The same counter, so the two interleave rather than each keeping a
      // tally the watcher would have to read separately.
      expect(store.fileRevisions.get("model.yaml")).toBe(2);
    });
  });

  describe("revisions", () => {
    it("remembers the revision a file was last read or written at", () => {
      // This is what a save sends back so the server can refuse a stale
      // baseline — the guard against one editor overwriting another's write.
      const store = useSectionDataStore();
      expect(store.revisionOf("model.yaml")).toBeNull();
      store.setRevision("model.yaml", "abc123");
      expect(store.revisionOf("model.yaml")).toBe("abc123");
      store.setRevision("model.yaml", "def456");
      expect(store.revisionOf("model.yaml")).toBe("def456");
    });

    it("ignores an absent revision rather than forgetting the one it has", () => {
      // A response that carries no revision is a response that says nothing
      // about it. Clearing on that would send the next save no baseline at all,
      // which is precisely the stale write the header exists to refuse.
      const store = useSectionDataStore();
      store.setRevision("model.yaml", "abc123");
      store.setRevision("model.yaml", null);
      store.setRevision("model.yaml", undefined);
      store.setRevision("model.yaml", "");
      expect(store.revisionOf("model.yaml")).toBe("abc123");
    });

    it("keeps revisions per file", () => {
      const store = useSectionDataStore();
      store.setRevision("model.yaml", "abc123");
      expect(store.revisionOf("nodes.yaml")).toBeNull();
    });
  });

  it("keeps the cache and the revisions independent of one another", () => {
    // They answer different questions — "have I read this section?" against
    // "is this buffer stale?" — and coupling them is how a cache clear would
    // start looking like a file change to Monaco.
    const store = useSectionDataStore();
    store.set("v1", "model.yaml", "techs", { ccgt: {} });
    expect(store.fileRevisions.get("model.yaml")).toBeUndefined();
    store.invalidateFile("v1", "model.yaml");
    expect(store.fileRevisions.get("model.yaml")).toBeUndefined();
  });
});
