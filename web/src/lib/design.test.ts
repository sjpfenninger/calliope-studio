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

const TOKENS_CSS = readFileSync(join(SRC, "assets/tokens.css"), "utf8");
const STYLE_CSS = readFileSync(join(SRC, "style.css"), "utf8");

/** Every `--<namespace>-<name>` declared in a stylesheet, as a set of names. */
function declared(css: string, namespace: string): Set<string> {
  const found = css.matchAll(new RegExp(`--${namespace}-([a-z0-9-]+)\\s*:`, "g"));
  return new Set([...found].map((m) => m[1]));
}

/**
 * Every colour-ish utility written in source, as `[file:line, prefix, name]`.
 *
 * Two boundaries do the work. The *leading* delimiter keeps this off
 * `var(--cg-shadow-2)`, because a `-` before the prefix is not a class boundary
 * — and variants come free with it, since a variant chain ends in `:`. The
 * *trailing* one forbids a following `:`, which is what separates a utility from
 * a CSS property: `border-radius:` inside a template literal is not a
 * `border-` utility naming the `radius` token, though it reads exactly like one.
 * A utility is never followed by `:`; a variant precedes what it modifies.
 */
const UTILITY =
  /(?:^|[\s"'`:[])((?:text|bg|border|ring|fill|stroke|divide|shadow)-([a-z0-9][a-z0-9-]*))(?![a-z0-9\-:])/g;

function utilities(): Array<{ where: string; prefix: string; name: string }> {
  return LINES.filter(
    // Prose about a rule is not a breach of it, as in `offenders`.
    (line) => !/^\s*(\/?\*|\/\/|<!--)/.test(line.text),
  ).flatMap((line) =>
    [...line.text.matchAll(UTILITY)].map((m) => ({
      where: `${line.file}:${line.no}  ${m[1]}`,
      prefix: m[1].slice(0, m[1].indexOf("-")),
      name: m[2],
    })),
  );
}

describe("design language", () => {
  it("names a token that exists, in every colour utility", () => {
    // The failure this exists for is silent in every direction: `text-text-muted`
    // typechecks, lints, reviews clean and renders *nothing* — Tailwind emits no
    // rule for a name that is not in `@theme inline`, so the element inherits
    // whatever is above it and looks approximately right. Twelve of them survived
    // in the tree, including one whose call site carried a comment explaining the
    // bug and working around it locally rather than fixing the token.
    //
    // The test is keyed on `--cg-*` rather than on a list of valid names, which
    // is what keeps it free of false positives: a utility is only checked when a
    // token of that exact name exists in `tokens.css`, i.e. when the author was
    // plainly reaching for the app's own vocabulary and the bridge in `style.css`
    // is what is missing. `text-sm`, `border-b` and `rounded-full` name no
    // `--cg-*` and are never considered.
    const cg = declared(TOKENS_CSS, "cg");
    const colours = declared(STYLE_CSS, "color");
    const missing = utilities()
      .filter(({ name }) => cg.has(name) && !colours.has(name))
      .map(({ where }) => where);
    expect([...new Set(missing)]).toEqual([]);
  });

  it("uses only the elevation steps the theme maps", () => {
    // `shadow-` is the one namespace with no overloading at all — every use is
    // elevation — so it can be checked as a closed set. The `--cg-shadow-0/1/2`
    // ramp is deliberately *not* those names: it reaches the DOM only through
    // Tailwind's seven, so a literal `shadow-1` is always wrong, and was.
    const steps = new Set([...declared(STYLE_CSS, "shadow"), "none"]);
    const missing = utilities()
      .filter(({ prefix, name }) => prefix === "shadow" && !steps.has(name))
      .map(({ where }) => where);
    expect([...new Set(missing)]).toEqual([]);
  });

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

  it("does not resize a shared constant at the call site", () => {
    // `cn(PRIMARY_BUTTON, "h-7 px-3")` is a new size tier invented in a template
    // — which is how the same dialog button came to exist at three paddings
    // across four files, none of them matching what `ui/button` renders. A tier
    // that does not exist should be added to `formClasses` and named, where the
    // re-typing rule above can then see it. Width, margin and flex are fine;
    // height, text size and radius are the contract.
    expect(
      offenders(
        "resize",
        /\bcn\(\s*[A-Z_]*(?:BUTTON|FIELD)[A-Z_]*\s*,[^)]*["'][^"']*\b(?:h-\d|size-\d|text-(?:2xs|xs|sm|base|lg)|rounded-)/,
      ),
    ).toEqual([]);
  });

  it("fills a segmented control to the strip that holds it", () => {
    // A `PanelHeader` is `h-7`/`h-8` *including* its `border-b`, so its content
    // box is a pixel short of any named height. An `h-7` segment in an `h-7`
    // strip overflowed by that pixel and `items-center` split it — half a pixel
    // over the hairline above and half over the one below, which is what a
    // smudged edge on both sides actually is. `SEGMENT_SIZE.fill` measures the
    // box rather than guessing at it. Two of the three nested strips got this
    // wrong, including the run sub-tabs.
    const bad = FILES.filter(({ rel, text }) => {
      if (!rel.startsWith("components/") || rel.startsWith("components/app/")) return false;
      // Only where a Segmented is nested inside a PanelHeader in the same file.
      if (!/<PanelHeader/.test(text) || !/<Segmented/.test(text)) return false;
      return /<Segmented\b[^>]*\bsize="(?!fill)/s.test(text);
    }).map(({ rel }) => rel);
    expect(bad).toEqual([]);
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
