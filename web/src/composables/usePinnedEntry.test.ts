import { describe, expect, it } from "vitest";
import { nextTick, ref } from "vue";

import { usePinnedEntry } from "./usePinnedEntry";

/**
 * An entry tab shows one entry, and the one thing that must not lose it is
 * renaming it: filtered by name on every render, the first keystroke of a
 * rename filtered the row out from under the cursor.
 */
describe("usePinnedEntry", () => {
  const load = () => [{ name: "ccgt" }, { name: "battery" }];

  it("shows everything on a section tab", () => {
    const entries = ref(load());
    const { visible } = usePinnedEntry(entries, () => null);
    expect(visible.value).toBe(entries.value);
  });

  it("keeps the entry through a rename", async () => {
    const entries = ref(load());
    const { visible } = usePinnedEntry(entries, () => "ccgt");
    expect(visible.value.map((entry) => entry.name)).toEqual(["ccgt"]);

    entries.value[0]!.name = "c";
    await nextTick();
    expect(visible.value.map((entry) => entry.name)).toEqual(["c"]);
  });

  it("re-pins by name when the list is reloaded", async () => {
    const entries = ref(load());
    const { pinned } = usePinnedEntry(entries, () => "battery");
    const before = pinned.value;

    entries.value = load();
    await nextTick();
    expect(pinned.value).not.toBe(before);
    expect(pinned.value?.name).toBe("battery");
  });

  it("shows nothing once the entry is removed", async () => {
    const entries = ref(load());
    const { visible } = usePinnedEntry(entries, () => "ccgt");
    entries.value.splice(0, 1);
    await nextTick();
    expect(visible.value).toEqual([]);
  });

  it("follows the tab to another entry", async () => {
    const entries = ref(load());
    const name = ref("ccgt");
    const { visible } = usePinnedEntry(entries, () => name.value);
    name.value = "battery";
    await nextTick();
    expect(visible.value.map((entry) => entry.name)).toEqual(["battery"]);
  });
});
