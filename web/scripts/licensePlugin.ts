/**
 * The build step that writes `THIRD_PARTY_LICENSES.md`.
 *
 * The set of packages is taken from Rollup's module graph rather than from
 * `pnpm licenses list`, and the difference is not cosmetic. That command
 * reports the whole production closure — 198 packages here, including `vite`,
 * `rollup`, `typescript` and `prettier`, none of which ship, and the
 * platform-specific `@esbuild/darwin-arm64`, `fsevents` and
 * `lightningcss-darwin-arm64`, which make its answer depend on the machine
 * that ran it. A notice that differs between a laptop and CI cannot be
 * committed and diffed, and the diff is the point.
 *
 * Two things the graph alone would miss, both unioned in below:
 *
 * - **Workers.** `?worker` imports are bundled by a *separate* Rollup build
 *   whose modules never reach the parent's `generateBundle`, and the main
 *   config's plugins do not apply to it. Measured, not assumed: without
 *   `worker.plugins` the notice covers 51 packages instead of 57, and the six
 *   it loses — `prettier` (monaco-yaml formats YAML with it),
 *   `vscode-languageserver-textdocument`, `vscode-languageserver-types`,
 *   `jsonc-parser`, `path-browserify` and `@vscode/l10n` — ship with no
 *   attribution at all. `collectPackages` is therefore registered on the
 *   worker builds too, accumulating into the module-level set they share.
 * - **Vendored source.** `src/components/ui/` is copied-in shadcn-vue. It is
 *   not in `node_modules`, so nothing automated can see it.
 */

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

import {
  byNameAndVersion,
  collect,
  packageRootFor,
  render,
  type PackageNotice,
} from "./licenseNotice";

/** Shared by the main build and every worker sub-build in the same process. */
const roots = new Set<string>();

function record(id: string): void {
  if (!id.includes("node_modules")) return;
  const root = packageRootFor(id);
  if (!root) {
    // Not a warning. A module we cannot attribute is a module shipped without
    // its notice, and the only way that gets noticed is if it stops the build.
    throw new Error(`Cannot find the package that owns ${id}; it would ship unattributed.`);
  }
  roots.add(realpathSync(root));
}

/**
 * Records the packages a build pulled in. Registered on the main build and,
 * through `worker.plugins`, on each worker build.
 */
export function collectPackages(): Plugin {
  return {
    name: "calliope-studio:collect-packages",
    apply: "build",
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        for (const id of chunk.moduleIds) record(id);
      }
    },
  };
}

/** The roots of the packages `package.json` names directly. */
function directDependencies(webDir: string): string[] {
  const manifest = JSON.parse(readFileSync(join(webDir, "package.json"), "utf8"));
  return Object.keys(manifest.dependencies ?? {}).map((name) =>
    // pnpm links every direct dependency into `node_modules/<name>`, so this
    // resolves without going through `require.resolve`, which fails on the
    // many packages whose `exports` map does not expose `./package.json`.
    realpathSync(join(webDir, "node_modules", name)),
  );
}

/**
 * Writes the notice once the bundle is on disk.
 *
 * Args:
 *   webDir: The `web/` directory.
 *   outFile: Where the notice goes — the repository root, so that
 *     `license-files` in `pyproject.toml` can name it.
 *   vendored: Entries for source copied into the tree rather than installed.
 */
export function writeLicenseNotice(
  webDir: string,
  outFile: string,
  vendored: PackageNotice[],
): Plugin {
  return {
    // The spread is what records the main build; worker builds have already
    // recorded themselves, during transform.
    ...collectPackages(),
    name: "calliope-studio:third-party-licenses",
    writeBundle() {
      for (const root of directDependencies(webDir)) roots.add(root);

      const entries = [...collect(roots), ...vendored].sort(byNameAndVersion);
      writeFileSync(outFile, render(entries), "utf8");
      this.info(`third-party licences: ${entries.length} packages -> ${outFile}`);
    },
  };
}
