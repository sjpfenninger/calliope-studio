import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, nextTick, ref } from "vue";

vi.mock("../api/versions", () => ({ getGeo: vi.fn() }));

import { getGeo } from "../api/versions";
import { useModelGeo } from "./useModelGeo";

/**
 * The saved geography, and how it degrades. A map that is a little old is
 * more use than no map, so a failed request keeps what was there.
 */
const geoApi = getGeo as ReturnType<typeof vi.fn>;
const payload = { nodes: [{ name: "a" }], links: [], colors: {} };

function mountGeo(versionId = ref("v1")) {
  let out!: ReturnType<typeof useModelGeo>;
  const wrapper = mount(
    defineComponent({
      setup() {
        out = useModelGeo(versionId);
        return () => null;
      },
    }),
  );
  return { wrapper, geo: out, versionId };
}

beforeEach(() => geoApi.mockReset());
afterEach(() => vi.useRealTimers());

describe("useModelGeo", () => {
  it("keeps the last geometry when a fetch fails, and says why", async () => {
    // Nulling it made every node read as unplaced, so one failed request put
    // three explanations on screen — banner, overlay, disabled Map segment.
    geoApi.mockResolvedValueOnce({ ...payload, source: "resolved" });
    const { geo } = mountGeo();
    await flushPromises();
    expect(geo.geo.value?.nodes).toHaveLength(1);

    geoApi.mockRejectedValueOnce(new Error("down"));
    await geo.reload();
    expect(geo.geo.value?.nodes).toHaveLength(1);
    expect(geo.error.value).toBe("down");
  });

  it("is no longer resolving once a version change stops the poll", async () => {
    // Left set, the hairline went on travelling under the next model's map
    // and the stale banner stayed suppressed until its own answer landed.
    geoApi.mockResolvedValue({ ...payload, source: "stale", resolve_task: "t1" });
    const { geo, versionId, wrapper } = mountGeo();
    await flushPromises();
    expect(geo.resolving.value).toBe(true);

    let land!: (value: unknown) => void;
    geoApi.mockReturnValue(new Promise((resolve) => (land = resolve)));
    versionId.value = "v2";
    await nextTick();
    expect(geo.resolving.value).toBe(false);
    land({ ...payload, source: "resolved" });
    await flushPromises();
    wrapper.unmount();
  });

  it("stays resolving between two polls of one resolve", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    geoApi.mockResolvedValue({ ...payload, source: "stale", resolve_task: "t1" });
    const { geo, wrapper } = mountGeo();
    await vi.advanceTimersByTimeAsync(0);
    expect(geo.resolving.value).toBe(true);
    await vi.advanceTimersByTimeAsync(1500);
    expect(geo.resolving.value).toBe(true);
    expect(geoApi).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });
});
