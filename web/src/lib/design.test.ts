/**
 * The design language, as assertions.
 *
 * A vitest test rather than a seventh browser check, because none of this needs
 * a server or a browser: it runs on every `npm test` and in CI without anyone
 * having to remember the six-command dance, and it can name a `file:line`.
 *
 * It reads bytes with `fs` and never shells out to `grep`. That is not fussiness
 * — three source files used to carry a literal NUL byte, which makes `grep` treat
 * them as binary and skip them *silently*, so the repo's own PrimeVue regression
 * guard was blind in the chart, the map and the multi-select. Rule 10 keeps that
 * from coming back; reading bytes directly means the rest of this file would
 * survive it anyway.
 *
 * A deliberate exception is spelled `// design-check: allow <rule>` on the line
 * itself or the one above it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

import * as formClasses from "./formClasses";
import {
  SEGMENT_BASE,
  SEGMENT_NAV_ACTIVE,
  SEGMENT_VALUE_ACTIVE,
} from "../components/app/segmented";

const SRC = join(import.meta.dirname, "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(vue|ts)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

interface Line {
  file: string;
  no: number;
  text: string;
  /** The few lines above, so a pragma can sit in a block comment. */
  before: string;
}

const FILES = walk(SRC).map((path) => ({
  path,
  rel: relative(SRC, path).split(sep).join("/"),
  text: readFileSync(path, "utf8"),
}));

const LINES: Line[] = FILES.flatMap(({ rel, text }) =>
  text.split("\n").map((line, i, all) => ({
    file: rel,
    no: i + 1,
    text: line,
    before: all.slice(Math.max(0, i - 10), i).join("\n"),
  })),
);

/** Every line matching `pattern`, minus the ones with an allow pragma. */
function offenders(
  rule: string,
  pattern: RegExp,
  where: (file: string) => boolean = () => true,
): string[] {
  const pragma = `design-check: allow ${rule}`;
  return LINES.filter(
    (line) =>
      where(line.file) &&
      // Prose about a rule is not a breach of it.
      !/^\s*(\/?\*|\/\/|<!--)/.test(line.text) &&
      pattern.test(line.text) &&
      !line.text.includes(pragma) &&
      !line.before.includes(pragma),
  ).map((line) => `${line.file}:${line.no}  ${line.text.trim().slice(0, 110)}`);
}

const isApp = (f: string) => !f.startsWith("components/ui/");
const isComponent = (f: string) =>
  f.startsWith("components/") && !f.startsWith("components/app/");

describe("design language", () => {
  it("has no re-typed copies of a shared class string", () => {
    // The whole point of a shared constant is that it is the only copy. Four
    // files had re-typed SECTION_HEADING verbatim, each with a different margin.
    const shared = Object.entries({
      ...formClasses,
      SEGMENT_BASE,
      SEGMENT_NAV_ACTIVE,
      SEGMENT_VALUE_ACTIVE,
    }).filter(([, value]) => typeof value === "string" && value.length > 30);

    const found = FILES.flatMap(({ rel, text }) =>
      shared
        .filter(
          ([, value]) =>
            rel !== "lib/formClasses.ts" &&
            rel !== "components/app/segmented.ts" &&
            text.includes(value as string),
        )
        .map(([name]) => `${rel} re-types ${name}`),
    );
    expect(found).toEqual([]);
  });

  it("keeps chrome-strip and footer geometry in components/app", () => {
    expect(
      offenders("strip", /\bh-[78]\b[^"']*\bborder-b\b[^"']*\bbg-panel\b/, isComponent),
    ).toEqual([]);
    expect(offenders("footer", /\bh-6\b[^"']*\bborder-t\b/, isComponent)).toEqual([]);
  });

  it("uses only the four control heights", () => {
    // 36, 40 and 44px are shadcn's scale leaking through; this app is 20/24/28/32.
    expect(offenders("height", /\bh-(9|10|11)\b/, isApp)).toEqual([]);
  });

  it("has no arbitrary geometry in a component", () => {
    // An arbitrary value is by definition off the contract.
    expect(
      offenders(
        "arbitrary",
        /\b(?:rounded|h|w|size|text|min-h|max-h)-\[(?!\d+vh|\d+vw|calc|inherit)/,
        (f) => f.startsWith("components/") || f.startsWith("views/"),
      ),
    ).toEqual([]);
  });

  it("never uses a text token as a fill, or a surface as a pill", () => {
    expect(offenders("role", /\bbg-text-(faint|muted|dim)\b/)).toEqual([]);
    // `bg-muted` is --cg-surface-2, one step from the panel it sits on: as a
    // pill fill it all but disappears once chrome has a tone of its own.
    expect(offenders("role", /\bbg-muted\b/, isApp)).toEqual([]);
  });

  it("has no /opacity modifier on a colour utility", () => {
    // Tailwind wraps these in color-mix(), which tokens.css forbids: it
    // compounds when nested and depends on whatever is behind it.
    expect(
      offenders(
        "opacity",
        /\b(?:bg|text|border|ring|fill|stroke|decoration)-[a-z0-9-]+\/[0-9]+/,
      ),
    ).toEqual([]);
  });

  it("has one focus mechanism", () => {
    // `outline-none` is a utility and beats the global :focus-visible rule in
    // the base layer, so a control carrying it has no keyboard indicator at all.
    expect(
      offenders(
        "focus",
        /focus-visible:ring|ring-offset|\boutline-none\b|\boutline-hidden\b/,
      ),
    ).toEqual([]);
  });

  it("has no dark: overrides in the primitives", () => {
    // Every --cg-* token already inverts; a dark: utility on top either does
    // nothing or fights it.
    expect(offenders("dark", /\bdark:/, (f) => f.startsWith("components/ui/"))).toEqual(
      [],
    );
  });

  it("has no !important utilities", () => {
    expect(offenders("important", /class="[^"]*(?:^|\s)![\w-]/)).toEqual([]);
  });

  it("writes literal colours only in tokens.css", () => {
    expect(
      offenders(
        "colour",
        /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/,
        (f) => f !== "assets/tokens.css" && !f.endsWith(".css"),
      ).filter(
        // The non-DOM renderers pass a hex fallback to cssVar/resolvedColor by
        // necessity — the probe has to have something to return before the
        // stylesheet lands.
        (line) => !/\bhex\(|resolvedColor|resolvedHex|cssVar|fallback/.test(line),
      ),
    ).toEqual([]);
  });

  it("has no scoped styles outside the documented exception", () => {
    const scoped = FILES.filter(
      ({ rel, text }) =>
        rel.startsWith("components/") &&
        /^<style scoped>/m.test(text) &&
        rel !== "components/editor/MonacoYamlEditor.vue",
    ).map(({ rel }) => rel);
    expect(scoped).toEqual([]);
  });

  it("has no NUL bytes in source", () => {
    // A NUL makes grep treat the file as binary and skip it without saying so.
    const binary = FILES.filter(({ text }) => text.includes("\0")).map((f) => f.rel);
    expect(binary).toEqual([]);
  });

  it("imports icons from one package", () => {
    expect(offenders("lucide", /lucide-vue-next/)).toEqual([]);
  });

  it("explains itself with a tooltip, not a native title", () => {
    // A native `title` is drawn by the OS: it cannot take a token, a radius or a
    // delay, it is the one surface this file can never reach, and it opens about
    // a second after the styled tooltip would. Two mechanisms in one row of
    // controls reads as broken rather than as two styles.
    //
    // The exception is the browser's *overflow* affordance — a `title` whose
    // value is the visible text, clipped. That is not help text, a tooltip
    // component would have to measure the clipping to know when to offer it, and
    // the rows that need it are the numerous ones. Those carry the pragma, as do
    // the components whose `title` is a prop rather than an attribute.
    expect(
      offenders("native-title", /\s:?title="/, (f) =>
        (f.startsWith("components/") || f.startsWith("views/")) && isApp(f),
      ),
    ).toEqual([]);
  });

  it("uses monospace only at the mono step", () => {
    // 11px is *the* mono step: IBM Plex Mono at 11px optically matches Inter at
    // 12px, which is why the scale in style.css says every app-side use of the
    // face is `font-mono text-xs`. At `text-2xs` it stops matching anything and
    // reads as a footnote in a different typeface — which is exactly how the
    // editors' inherited-values box looked, and what a user notices about that
    // screen without being able to name it.
    //
    // Line-based, so it catches the two classes written into one string and not
    // `cn(FIELD, "font-mono")`, where the size comes from the other constant.
    // FIELD_MONO exists so that case has nowhere left to occur.
    expect(
      offenders(
        "mono",
        /\bfont-mono\b[^"']*\btext-2xs\b|\btext-2xs\b[^"']*\bfont-mono\b/,
        isApp,
      ),
    ).toEqual([]);
  });
});
