import { afterEach, describe, expect, it, vi } from "vitest";

import { saveText } from "./download";

/**
 * The guarantee is "ask first". An export that lands silently in the downloads
 * folder is a file the user then has to go and find, under a name they never
 * chose — and cancelling the dialog has to mean the file is not written.
 */

type Picker = ReturnType<typeof stubPicker>;

function stubPicker(behaviour: "accept" | "cancel" | "refuse" = "accept") {
  const written: string[] = [];
  const asked: Array<{ suggestedName?: string }> = [];

  const showSaveFilePicker = vi.fn(async (options: { suggestedName?: string }) => {
    asked.push(options);
    if (behaviour === "cancel") {
      throw Object.assign(new Error("The user aborted a request."), {
        name: "AbortError",
      });
    }
    if (behaviour === "refuse") {
      throw Object.assign(new Error("Not allowed here."), { name: "SecurityError" });
    }
    return {
      createWritable: async () => ({
        write: async (data: string) => {
          written.push(data);
        },
        close: async () => {},
      }),
    };
  });

  Object.defineProperty(window, "showSaveFilePicker", {
    value: showSaveFilePicker,
    configurable: true,
    writable: true,
  });

  return { written, asked, showSaveFilePicker };
}

/** Watches the anchor route, which is the fallback and must not fire otherwise. */
function watchAnchor() {
  const clicked: Array<{ download: string }> = [];
  const create = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const element = create(tag);
    if (tag === "a") {
      element.click = () => clicked.push({ download: (element as HTMLAnchorElement).download });
    }
    return element;
  });
  // happy-dom has no object-URL support.
  if (!URL.createObjectURL) {
    URL.createObjectURL = vi.fn(() => "blob:stub") as never;
    URL.revokeObjectURL = vi.fn() as never;
  }
  return clicked;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
});

describe("saveText", () => {
  it("asks where to save, suggesting the name", async () => {
    const picker: Picker = stubPicker();
    const anchor = watchAnchor();

    expect(await saveText("national-flow_cap.csv", "a,b\n1,2\n")).toBe(true);

    expect(picker.asked).toHaveLength(1);
    expect(picker.asked[0].suggestedName).toBe("national-flow_cap.csv");
    expect(picker.written).toEqual(["a,b\n1,2\n"]);
    // Not both — the file would be saved twice, once where it was asked for.
    expect(anchor).toHaveLength(0);
  });

  it("writes nothing at all when the user cancels", async () => {
    const picker: Picker = stubPicker("cancel");
    const anchor = watchAnchor();

    expect(await saveText("x.csv", "a,b\n")).toBe(false);

    expect(picker.written).toEqual([]);
    // The whole point: falling back here would save the file just declined.
    expect(anchor).toHaveLength(0);
  });

  it("falls back to a download when the browser has no picker", async () => {
    const anchor = watchAnchor();

    expect(await saveText("x.csv", "a,b\n")).toBe(true);

    expect(anchor).toEqual([{ download: "x.csv" }]);
  });

  it("falls back rather than losing the file when the picker is refused", async () => {
    stubPicker("refuse");
    const anchor = watchAnchor();

    expect(await saveText("x.csv", "a,b\n")).toBe(true);

    // A policy block is not the user saying no, so the export still happens.
    expect(anchor).toEqual([{ download: "x.csv" }]);
  });
});
