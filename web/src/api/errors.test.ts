import { describe, expect, it } from "vitest";

import { errorDetail, isConflict } from "./errors";

/**
 * The one way a failure is read, and the reason it is one way.
 *
 * Before this module there were six idioms, and the difference reached the user:
 * an axios rejection *is* an `Error`, whose `message` is the string "Request
 * failed with status code 500" — so a surface reading `caught.message` showed
 * that where the pane next to it showed FastAPI's own explanation of what went
 * wrong. The precedence below is the whole fix, and it is invisible to a type
 * check: every branch returns a `string`, so getting the order wrong compiles,
 * lints and reviews clean while quietly showing the worse of two answers.
 */

/** What axios actually hands a `catch`: an Error carrying a response. */
function axiosError(
  status: number,
  data: unknown = undefined,
  message = `Request failed with status code ${status}`,
): Error {
  return Object.assign(new Error(message), { response: { status, data } });
}

describe("errorDetail", () => {
  it("prefers the server's own explanation to everything else", () => {
    const caught = axiosError(400, {
      detail: "override path `config.init.name.deeper` cannot exist",
    });
    expect(errorDetail(caught, "Failed to save scenarios.")).toBe(
      "override path `config.init.name.deeper` cannot exist",
    );
  });

  it("prefers the detail even when the rejection is also an Error with a message", () => {
    // The regression this module exists for: `caught.message` is populated on
    // every axios rejection, so a check in the wrong order never falls through
    // to the detail and the useful message is never seen.
    const caught = axiosError(500, { detail: "Solver binary not found." });
    expect(errorDetail(caught, "Failed to run.")).toBe("Solver binary not found.");
  });

  it("narrows a bodyless failure by status rather than saying nothing", () => {
    expect(errorDetail(axiosError(500), "Failed to save.")).toBe(
      "Request failed (500).",
    );
  });

  it("says what a 404 means, because the status alone is not actionable", () => {
    expect(errorDetail(axiosError(404), "Failed to load.")).toBe("Not found.");
    // Even with a body, as long as it carries no detail.
    expect(errorDetail(axiosError(404, {}), "Failed to load.")).toBe("Not found.");
  });

  it("ignores an empty detail and falls through to the status", () => {
    // An empty string is not an explanation, and returning it would put a blank
    // where the error message goes — which reads as no error at all.
    expect(errorDetail(axiosError(500, { detail: "" }), "Failed.")).toBe(
      "Request failed (500).",
    );
  });

  it("falls through to the status for a detail that is not a string", () => {
    // FastAPI's request-validation errors make `detail` a *list* of objects. It
    // is not a sentence and must not be stringified into one: `[object Object]`
    // in front of a user is worse than "Request failed (422)."
    const caught = axiosError(422, {
      detail: [{ loc: ["body", "name"], msg: "field required", type: "missing" }],
    });
    expect(errorDetail(caught, "Failed to create.")).toBe("Request failed (422).");
    // Same rule for any other shape a handler might put there.
    expect(errorDetail(axiosError(400, { detail: { code: 7 } }), "Failed.")).toBe(
      "Request failed (400).",
    );
  });

  it("passes on the message of a plain Error", () => {
    // A TypeError from our own code, or a network failure with no response at
    // all: both say something worth showing, and neither has a status.
    expect(errorDetail(new TypeError("x is not a function"), "Failed.")).toBe(
      "x is not a function",
    );
    expect(errorDetail(new Error("Network Error"), "Failed to load.")).toBe(
      "Network Error",
    );
  });

  it("falls back when the error carries nothing usable at all", () => {
    // The fallback names the action, so these are the cases where the caller's
    // own sentence is the best available answer.
    expect(errorDetail(new Error(""), "Failed to save.")).toBe("Failed to save.");
    expect(errorDetail(null, "Failed to save.")).toBe("Failed to save.");
    expect(errorDetail(undefined, "Failed to save.")).toBe("Failed to save.");
    expect(errorDetail("a thrown string", "Failed to save.")).toBe("Failed to save.");
    expect(errorDetail({ response: {} }, "Failed to save.")).toBe("Failed to save.");
  });

  it("survives an argument of any shape, because a catch binding is unknown", () => {
    // Ten `catch (e: any)` blocks became this, so it is reached with whatever a
    // library felt like throwing. Anything that reads a property off it without
    // optional chaining throws *from the error handler*, losing the original.
    for (const caught of [0, false, [], Symbol("s"), () => {}]) {
      expect(errorDetail(caught, "Failed.")).toBe("Failed.");
    }
  });
});

describe("isConflict", () => {
  it("is true for 409 and nothing else", () => {
    // A save surface treats this one status differently — the buffer is stale,
    // so the offer is "reload", not "retry". Widening it would offer a reload
    // for a failure a reload cannot fix.
    expect(isConflict(axiosError(409))).toBe(true);
    for (const status of [400, 404, 408, 410, 419, 500]) {
      expect(isConflict(axiosError(status))).toBe(false);
    }
  });

  it("is false for anything that is not an axios rejection", () => {
    expect(isConflict(new Error("Conflict"))).toBe(false);
    expect(isConflict(null)).toBe(false);
    expect(isConflict(undefined)).toBe(false);
    expect(isConflict({ status: 409 })).toBe(false);
    // Strict equality: a status arriving as text is not a 409 conflict.
    expect(isConflict({ response: { status: "409" } })).toBe(false);
  });
});
