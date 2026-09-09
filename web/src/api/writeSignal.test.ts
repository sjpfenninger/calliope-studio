import { describe, expect, it, vi } from "vitest";

import { installWriteSignal, isVersionWrite, onVersionWrite } from "./writeSignal";

/**
 * The signal is what keeps the git status honest after a save. A listener
 * that never fires shows a stale count for ever, and one that fires on a
 * read polls `git status` on every request in the app.
 */
describe("isVersionWrite", () => {
  it.each([
    ["a file save", { method: "put", url: "/api/versions/abc/files/model.yaml" }],
    ["a section save", { method: "PUT", url: "/api/versions/abc/yaml-section/x" }],
    ["a file created", { method: "post", url: "/api/versions/abc/files/new.yaml" }],
    ["a file deleted", { method: "delete", url: "/api/versions/abc/files/old.yaml" }],
    ["a commit", { method: "post", url: "/api/versions/abc/vcs/commit/" }],
    ["a run started", { method: "post", url: "/api/versions/abc/runs/" }],
  ])("counts %s", (_label, config) => {
    expect(isVersionWrite(config)).toBe(true);
  });

  it.each([
    ["a read", { method: "get", url: "/api/versions/abc/files/model.yaml" }],
    ["the default method", { url: "/api/versions/abc/files/model.yaml" }],
    ["a run action", { method: "post", url: "/api/runs/abc/cancel/" }],
    ["a project registered", { method: "post", url: "/api/projects/" }],
    ["nothing at all", undefined],
  ])("ignores %s", (_label, config) => {
    expect(isVersionWrite(config)).toBe(false);
  });
});

describe("installWriteSignal", () => {
  function fakeClient() {
    let handler: ((response: unknown) => unknown) | null = null;
    return {
      client: {
        interceptors: {
          response: { use: (onFulfilled: (response: unknown) => unknown) => (handler = onFulfilled) },
        },
      },
      respond: (config: unknown) => handler!({ config }),
    };
  }

  it("tells every listener about a write, and passes the response through", () => {
    const { client, respond } = fakeClient();
    installWriteSignal(client as never);
    const heard = vi.fn();
    const stop = onVersionWrite(heard);

    const response = respond({ method: "put", url: "/api/versions/a/files/x" });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(response).toEqual({ config: { method: "put", url: "/api/versions/a/files/x" } });

    respond({ method: "get", url: "/api/versions/a/files/x" });
    expect(heard).toHaveBeenCalledTimes(1);

    stop();
    respond({ method: "put", url: "/api/versions/a/files/x" });
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
