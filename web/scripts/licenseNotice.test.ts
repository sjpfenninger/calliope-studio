/**
 * What the third-party notice must say, and what it must refuse to say.
 *
 * The file this renders is a legal artefact that nobody reads until it
 * matters, so the failures worth guarding are the quiet ones: a package listed
 * with no terms at all, a licence text truncated by its own backticks, and an
 * order that shifts between the machine that committed the file and the one
 * that checks it.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { byNameAndVersion, packageRootFor, readPackage, render } from "./licenseNotice";
import type { PackageNotice } from "./licenseNotice";

/** An absolute path into `web/node_modules`; vitest's root is `web/`. */
function modulePath(relative: string): string {
  return resolve("node_modules", relative);
}

function entry(overrides: Partial<PackageNotice> = {}): PackageNotice {
  return {
    name: "example",
    version: "1.0.0",
    license: "MIT",
    homepage: "https://example.invalid",
    texts: [{ file: "LICENSE", text: "MIT License\n\nCopyright (c) nobody\n" }],
    ...overrides,
  };
}

describe("render", () => {
  it("carries every licence text verbatim", () => {
    const text = "BSD 3-Clause\n\n  1. Redistributions of source code…\n";
    const out = render([entry({ texts: [{ file: "LICENSE", text }] })]);
    expect(out).toContain(text.trimEnd());
  });

  it("lists a package in the table and gives it a section", () => {
    const out = render([entry({ name: "katex", version: "0.18.4" })]);
    expect(out).toContain("| [katex](https://example.invalid) | `0.18.4` | MIT |");
    expect(out).toContain("## katex 0.18.4");
  });

  it("keeps a package that ships no licence file, naming the terms it declares", () => {
    // Four packages in the tree are like this. Dropping them would be silent
    // under-attribution; the SPDX id is what remains true about them.
    const out = render([entry({ name: "@vscode/l10n", texts: [] })]);
    expect(out).toContain("## @vscode/l10n 1.0.0");
    expect(out).toContain("`MIT`");
  });

  it("refuses to write an empty notice", () => {
    // A collector that found nothing must not produce a file that reads as if
    // the bundle contains no third-party code at all.
    expect(() => render([])).toThrow(/empty/i);
  });

  it("lengthens the fence when a licence contains one", () => {
    // A licence quoting a fenced code block would otherwise close the block
    // early and swallow the rest of the file.
    const text = "See:\n```\nexample\n```\nend";
    const out = render([entry({ texts: [{ file: "LICENSE", text }] })]);
    expect(out).toContain("````\nSee:");
    expect(out).toContain("end\n````");
  });

  it("marks vendored source, which has no version", () => {
    const out = render([entry({ name: "shadcn-vue", version: null })]);
    expect(out).toContain("| vendored |");
    expect(out).toContain("## shadcn-vue\n");
  });
});

describe("byNameAndVersion", () => {
  it("breaks a name tie on version", () => {
    // `tslib` really is in the bundle twice, at 2.3.0 and 2.8.1. Without this
    // the order would come from the set, i.e. from however Rollup walked the
    // graph — and the committed file is diffed against a rebuild.
    const sorted = [
      entry({ name: "tslib", version: "2.8.1" }),
      entry({ name: "apache-arrow" }),
      entry({ name: "tslib", version: "2.3.0" }),
    ].sort(byNameAndVersion);
    expect(sorted.map((e) => `${e.name}@${e.version}`)).toEqual([
      "apache-arrow@1.0.0",
      "tslib@2.3.0",
      "tslib@2.8.1",
    ]);
  });
});

describe("readPackage", () => {
  function fixture(manifest: Record<string, unknown>, files: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "licence-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return dir;
  }

  it("refuses a package that states its terms nowhere", () => {
    // The one failure that must stop the build. Degrading to "unknown" would
    // leave the notice looking complete while being the single thing it must
    // not be, and nobody re-reads a generated legal file to find out.
    const dir = fixture({ name: "silent", version: "1.0.0" });
    expect(() => readPackage(dir)).toThrow(/states its licence nowhere/);
  });

  it("accepts a declared licence with no file, and a file with no declaration", () => {
    expect(readPackage(fixture({ name: "a", license: "MIT" })).texts).toHaveLength(0);
    expect(readPackage(fixture({ name: "b" }, { LICENSE: "terms" })).license).toBeNull();
  });

  it("takes NOTICE and ThirdPartyNotices as terms, not just LICENSE", () => {
    // Apache-2.0 section 4(d) lives in the first, and Monaco states the
    // CC-BY-4.0 licence of the codicon font we ship only in the second.
    const dir = fixture(
      { name: "c", license: "Apache-2.0" },
      { NOTICE: "attribution", "ThirdPartyNotices.txt": "codicons are CC-BY-4.0", README: "no" },
    );
    expect(readPackage(dir).texts.map((t) => t.file)).toEqual([
      "NOTICE",
      "ThirdPartyNotices.txt",
    ]);
  });

  it("reads a CRLF licence file as LF", () => {
    // jsonc-parser and both tslibs ship one, and the notice is committed under
    // `* text=auto eol=lf`. A CR that survives here is not cosmetic: the
    // regenerated file then differs from its blob in a way `git diff` hides and
    // `git status` reports, which is what setuptools-scm reads — so the v0.1.2
    // release built a dirty tree and stamped a version that was not the tag.
    const dir = fixture({ name: "crlf", license: "MIT" }, { LICENSE: "a\r\nb\r\n" });
    expect(readPackage(dir).texts[0].text).toBe("a\nb\n");
  });

  it("turns npm's owner/repo shorthand into a URL", () => {
    // `clsx`, `defu` and `markdown-it` all write it that way, and markdown
    // renders the bare form as a link to a page that does not exist.
    const dir = fixture({ name: "d", license: "MIT", repository: "lukeed/clsx" });
    expect(readPackage(dir).homepage).toBe("https://github.com/lukeed/clsx");
  });
});

describe("packageRootFor", () => {
  it("ignores a module that is not in node_modules", () => {
    expect(packageRootFor("/repo/web/src/main.ts")).toBeNull();
  });

  it("finds the package a real module belongs to, through pnpm's store", () => {
    // Not a fixture: the point is that the rule holds against the layout pnpm
    // actually produces, symlinks, scopes, `.pnpm` and all. Paths are built
    // with `resolve` rather than `new URL(…, import.meta.url)`, which Vite
    // rewrites at transform time into an asset URL — the path arrives here
    // stripped to `/node_modules/…` and nothing says why.
    const root = packageRootFor(modulePath("katex/dist/katex.mjs"));
    expect(root).not.toBeNull();
    expect(readPackage(root as string).name).toBe("katex");
  });

  it("strips a query suffix, which Rollup puts on worker and asset ids", () => {
    const base = modulePath("katex/dist/katex.mjs");
    expect(packageRootFor(`${base}?worker`)).toBe(packageRootFor(base));
  });

  it("keeps the scope, which is part of the package name", () => {
    const root = packageRootFor(modulePath("@lucide/vue/dist/index.js"));
    expect(readPackage(root as string).name).toBe("@lucide/vue");
  });
});
