/**
 * Calliope's LaTeX → HTML, for the Math tab.
 *
 * **This is the second place model-derived content reaches the DOM as markup**,
 * after `lib/markdown.ts`, and it has its own security model rather than
 * borrowing that one. `trust: false` is what makes it safe: KaTeX will not
 * expand `\href`, `\url`, `\includegraphics` or `\htmlClass`, which are the only
 * commands that can put an attacker-chosen attribute into the output. Everything
 * else it emits is spans and their geometry. So, as with `html: false` next
 * door, there is nothing for a sanitizer to do — but the reason is different and
 * the flag is not optional. Do not set `trust` without adding one.
 *
 * The strings themselves come from Calliope's own LaTeX backend, escaped by
 * Calliope's own filters — whose comments in `latex_backend_model.py` say "KaTeX
 * requires…" by name, which is why this is KaTeX and not MathJax. `_ESCAPE` in
 * `runs/mathdoc.py` is the other end of that, and
 * `tests/test_math_render.py::TestKatexCompatibility` is what holds the two
 * together.
 *
 * `throwOnError: false` on purpose. A formulation is a few hundred equations and
 * a user's own math is among them; one command KaTeX does not know must render
 * as a marked-up error in place, not take the whole pane down with an exception
 * from inside a render function.
 */
import katex from "katex";

/**
 * Rendered equations, by source string.
 *
 * The list re-renders on every filter keystroke and every selection, and these
 * are `\begin{array}` blocks of a hundred-odd tokens each. Keyed on the LaTeX
 * itself rather than on the component name because the string *is* the identity:
 * a re-render that produced different HTML for the same input would be a bug.
 */
const cache = new Map<string, RenderedMath>();

/** How many to keep. Well past a whole formulation, which is ~120 components. */
const CACHE_LIMIT = 512;

export interface RenderedMath {
  /** KaTeX's HTML. Safe to bind with `v-html`; see the module docblock. */
  html: string;
  /** What KaTeX complained about, if it could not read the source. */
  error: string | null;
}

export function renderLatex(source: string): RenderedMath {
  const trimmed = source?.trim() ?? "";
  if (!trimmed) return { html: "", error: null };

  const cached = cache.get(trimmed);
  if (cached) return cached;

  let rendered: RenderedMath;
  try {
    rendered = {
      html: katex.renderToString(trimmed, {
        displayMode: true,
        // See the docblock: this is the security model, not a preference.
        trust: false,
        // Marked-up error in place rather than an exception out of a render.
        throwOnError: false,
        // Calliope's output is generated, not hand-written, and its unicode and
        // spacing choices are deliberate. "warn" would put a console entry
        // beside every one of a hundred equations and say nothing actionable.
        strict: "ignore",
        output: "html",
      }),
      error: null,
    };
  } catch (error) {
    // Reached only for the failures `throwOnError: false` does not cover — a
    // malformed environment, mostly. Still not allowed to escape.
    rendered = { html: "", error: error instanceof Error ? error.message : String(error) };
  }

  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(trimmed, rendered);
  return rendered;
}

/**
 * Whether KaTeX rendered the source without complaint.
 *
 * `throwOnError: false` reports a problem *inside* the HTML, as a `.katex-error`
 * span, so a caller that only looked at `error` would call a broken equation
 * fine. The Math tab uses this to say so beside the component rather than
 * leaving a red string of source where notation should be.
 */
export function hasRenderError(rendered: RenderedMath): boolean {
  return rendered.error !== null || rendered.html.includes("katex-error");
}
