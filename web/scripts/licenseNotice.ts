/**
 * Attribution for the third-party code that ships inside the Python package.
 *
 * The Vue bundle is compiled into `src/calliope_studio/server/static/` and is
 * redistributed inside every wheel, sdist and conda package. Minification
 * strips the `@license` banners the sources carry — a grep of the built bundle
 * finds not one of them — so nothing in the shipped artefact says that it
 * contains BSD-3, Apache-2.0, OFL-1.1 and CC-BY-4.0 material, all of which
 * require their notices to travel with the copy. This is where those notices
 * are kept instead.
 *
 * Split in two on purpose. `collect` touches the filesystem and is driven by
 * the build; `render` is pure, so what a reader is actually told can be tested
 * without a `node_modules` tree.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * What a package uses to carry its terms.
 *
 * `NOTICE` and `ThirdPartyNotices` are not padding: the first is how
 * apache-arrow and echarts satisfy Apache-2.0 section 4(d), and the second is
 * the only place Monaco states that the `codicon.ttf` we ship is CC-BY-4.0
 * rather than MIT like the rest of the package.
 */
const LICENSE_FILE = /^(licen[cs]e|copying|notice|thirdpartynotices)/i;

/** A file inside a package that states terms, kept verbatim. */
export interface LicenseText {
  file: string;
  text: string;
}

/** One attributed package, as the notice presents it. */
export interface PackageNotice {
  name: string;
  /** Null for vendored source, which has no version of its own. */
  version: string | null;
  /** The SPDX expression the package declares, or null if it declares none. */
  license: string | null;
  homepage: string | null;
  texts: LicenseText[];
}

/**
 * The package directory a module id belongs to, or null if it is not in one.
 *
 * The rule is *node's* layout — the directory after the last `node_modules`
 * segment, plus one more for a scope — not pnpm's
 * `.pnpm/<name>@<ver>_<hash>/node_modules/<name>` shape, which is an internal
 * format free to change under us. It also beats walking up to the nearest
 * `package.json`, because packages routinely ship a stub one in `esm/` or
 * `dist/` carrying nothing but `{"type": "module"}`.
 */
export function packageRootFor(id: string): string | null {
  // Rollup hands out ids with a query suffix (`?worker`, `?used`) and virtual
  // modules with a leading NUL, and on Windows the separator is a backslash
  // while Vite's own ids are posix. Normalise all of it before splitting.
  const parts = id.replace(/^\0/, "").split("?")[0].replace(/\\/g, "/").split("/");
  const last = parts.lastIndexOf("node_modules");
  if (last === -1) return null;

  let end = last + 2;
  if (parts[last + 1]?.startsWith("@")) end += 1;
  if (end > parts.length) return null;

  const root = parts.slice(0, end).join("/");
  return existsSync(join(root, "package.json")) ? root : null;
}

/** The declared SPDX expression, across the three spellings npm has had. */
function declaredLicense(manifest: Record<string, unknown>): string | null {
  const license = manifest.license;
  if (typeof license === "string") return license;
  // The pre-SPDX object form, `{ "type": "MIT", "url": ... }`.
  if (license && typeof license === "object" && "type" in license) {
    const type = (license as { type?: unknown }).type;
    if (typeof type === "string") return type;
  }
  const legacy = manifest.licenses;
  if (Array.isArray(legacy)) {
    const types = legacy
      .map((entry) => (typeof entry === "string" ? entry : entry?.type))
      .filter((type): type is string => typeof type === "string");
    if (types.length) return types.join(" OR ");
  }
  return null;
}

/** npm's `owner/repo` shorthand, which markdown would render as a dead link. */
const REPO_SHORTHAND = /^[\w.-]+\/[\w.-]+$/;

function asUrl(value: string): string {
  const url = value.replace(/^git\+/, "").replace(/\.git$/, "");
  return REPO_SHORTHAND.test(url) ? `https://github.com/${url}` : url;
}

function declaredHomepage(manifest: Record<string, unknown>): string | null {
  if (typeof manifest.homepage === "string") return asUrl(manifest.homepage);
  const repository = manifest.repository;
  if (typeof repository === "string") return asUrl(repository);
  if (repository && typeof repository === "object" && "url" in repository) {
    const url = (repository as { url?: unknown }).url;
    if (typeof url === "string") return asUrl(url);
  }
  return null;
}

/**
 * Reads one package directory into the entry the notice will show.
 *
 * Throws when a package states its terms nowhere — neither a licence file nor
 * a `license` field. Degrading to "unknown" would put a package into a legal
 * notice with nothing legal in it, which is worse than a failed build: the
 * file would look complete while being the one thing it must not be.
 */
export function readPackage(root: string): PackageNotice {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const name = typeof manifest.name === "string" ? manifest.name : null;
  if (!name) {
    throw new Error(`${root}: package.json declares no name`);
  }

  const texts = readdirSync(root)
    // readdir order is filesystem order, and this file is committed and
    // diffed — so it has to come out the same on every machine that builds it.
    .sort()
    .filter((file) => LICENSE_FILE.test(file) && statSync(join(root, file)).isFile())
    .map((file) => ({
      file,
      // jsonc-parser and both tslibs ship their licence files with CRLF. The
      // notice is committed under `* text=auto eol=lf`, so passing those bytes
      // through leaves the working tree modified in the one way nothing sees:
      // `git diff` normalises the CRLF away and reports no change, while
      // `git status` calls the file modified — and `git status` is what
      // setuptools-scm reads, so the release build took the tree for dirty and
      // stamped a dated, bumped version that could not be the tag.
      text: readFileSync(join(root, file), "utf8").replace(/\r\n/g, "\n"),
    }));

  const license = declaredLicense(manifest);
  if (!license && texts.length === 0) {
    throw new Error(
      `${name} (${root}) states its licence nowhere: no licence file and no ` +
        "`license` field. It cannot be attributed, so it cannot be shipped.",
    );
  }

  return {
    name,
    version: typeof manifest.version === "string" ? manifest.version : null,
    license,
    homepage: declaredHomepage(manifest),
    texts,
  };
}

/**
 * A total order over entries, so the committed file is a function of the tree
 * and nothing else.
 *
 * Name alone is not enough: `tslib` is in here twice at two versions, and
 * leaving that tie to the set's insertion order would make the notice depend
 * on the order Rollup happened to walk the graph.
 */
export function byNameAndVersion(a: PackageNotice, b: PackageNotice): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return (a.version ?? "").localeCompare(b.version ?? "", "en");
}

/** Reads every package root, in a stable order. */
export function collect(roots: Iterable<string>): PackageNotice[] {
  return [...new Set(roots)].map(readPackage).sort(byNameAndVersion);
}

/**
 * A fence long enough to hold `text`.
 *
 * A licence quoting a code block would otherwise close the block early and
 * take the rest of the file with it — corruption that renders fine right up to
 * the paragraph that matters.
 */
function fenceFor(text: string): string {
  const longest = [...text.matchAll(/`+/g)].reduce(
    (max, match) => Math.max(max, match[0].length),
    0,
  );
  return "`".repeat(Math.max(3, longest + 1));
}

const PREAMBLE = `# Third-party licences

Calliope Studio's browser interface is compiled into
\`src/calliope_studio/server/static/\` and redistributed inside every wheel,
sdist and conda package. Minification strips the licence banners the sources
carry, so the notices the packages below require are kept here instead.

Generated by \`pixi run web-build\` from the packages Rollup put in the bundle,
and committed so that a dependency change shows up as a diff. Do not edit it by
hand.

Calliope Studio itself is AGPL-3.0-or-later; its terms are in \`LICENSE\`.
`;

/** Renders the notice. Pure — everything it needs is in `entries`. */
export function render(entries: PackageNotice[]): string {
  if (entries.length === 0) {
    throw new Error("Refusing to write an empty third-party licence notice.");
  }

  const rows = entries.map((entry) => {
    const version = entry.version ? `\`${entry.version}\`` : "vendored";
    const link = entry.homepage ? `[${entry.name}](${entry.homepage})` : entry.name;
    return `| ${link} | ${version} | ${entry.license ?? "see text"} |`;
  });

  const sections = entries.map((entry) => {
    const lines = [entry.version ? `## ${entry.name} ${entry.version}` : `## ${entry.name}`, ""];
    if (entry.license) lines.push(`SPDX: \`${entry.license}\``, "");
    if (entry.homepage) lines.push(`<${entry.homepage}>`, "");
    if (entry.texts.length === 0) {
      // Every SPDX id that reaches this branch is one whose full text another
      // package in the same file carries, so the notice stays complete.
      lines.push(
        `This package ships no licence file. Its terms are those of the \`${entry.license}\``,
        "licence named above.",
        "",
      );
    }
    for (const { file, text } of entry.texts) {
      const fence = fenceFor(text);
      lines.push(`### ${file}`, "", fence, text.replace(/\s+$/, ""), fence, "");
    }
    return lines.join("\n");
  });

  return [
    PREAMBLE,
    "## Contents",
    "",
    "| Package | Version | Licence |",
    "| --- | --- | --- |",
    ...rows,
    "",
    "---",
    "",
    sections.join("\n---\n\n"),
  ].join("\n");
}
