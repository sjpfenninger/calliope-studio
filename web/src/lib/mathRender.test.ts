/**
 * Calliope's LaTeX, through KaTeX.
 *
 * The strings here are real output from `runs/mathdoc.py` on Calliope 0.7.0.dev7
 * — `balance_conversion` because it is the one `urban_scale`'s own math
 * overrides, and `flow_cap` because a variable's bounds render differently from
 * a constraint. They are pasted rather than generated so this stays a unit test
 * with no Python in it, and so a Calliope change shows up as a *diff* here
 * rather than as a silently different input.
 *
 * What would break without this: KaTeX refuses a whole expression on one command
 * it does not know, and `throwOnError: false` means the refusal renders as a
 * marked-up error rather than raising — so a formulation would look plausible
 * with an equation missing from the middle of it and nothing in the console.
 * `\negthickspace`, `\mathord`, `\!\!` and `\(…\)` nested inside `\text{}` are
 * the four Calliope leans on that are not obviously safe.
 */
import { describe, expect, it } from "vitest";

import { hasRenderError, renderLatex } from "./mathRender";

/** `constraints.balance_conversion`, as `additional_math.yaml` overrides it. */
const BALANCE_CONVERSION =
  "\\begin{array}{l}\n    \\forall{}\n    \\text{ node }\\negthickspace \\in \\negthickspace\\text{ nodes, }\n" +
  "    \\text{ tech }\\negthickspace \\in \\negthickspace\\text{ techs, }\n" +
  "    \\text{ timestep }\\negthickspace \\in \\negthickspace\\text{ timesteps }\n    \\!\\!,\\\\\n" +
  "    \\text{if } (\\textit{base\\_tech}_\\text{tech}\\mathord{==}\\text{conversion} \\land \\neg (\\textit{include\\_storage}\\mathord{==}\\text{true}))\\!\\!:\\\\[2em]\n" +
  "    \\quad \\text{if } (\\neg (\\text{tech} \\in \\text{[chp]}))\\!\\!:\\\\\n" +
  "    \\qquad \\sum\\limits_{\\text{carrier} \\in \\text{carriers}} (\\textbf{flow\\_out\\_inc\\_eff}_\\text{node,tech,carrier,timestep})" +
  " = \\sum\\limits_{\\text{carrier} \\in \\text{carriers}} (\\textbf{flow\\_in\\_inc\\_eff}_\\text{node,tech,carrier,timestep})\\\\[2em]\n" +
  "\\end{array}";

/** `variables.flow_cap` — bounds, and the `\in\mathbb{R}` domain line. */
const FLOW_CAP =
  "\\begin{array}{l}\n    \\forall{}\n    \\text{ node }\\negthickspace \\in \\negthickspace\\text{ nodes, }\n" +
  "    \\text{ tech }\\negthickspace \\in \\negthickspace\\text{ techs, }\n" +
  "    \\text{ carrier }\\negthickspace \\in \\negthickspace\\text{ carriers }\n    \\!\\!,\\\\\n" +
  "    \\in\\mathbb{R}\\;\\!\\!:\\\\[2em]\n" +
  "    \\quad \\textit{flow\\_cap\\_min} \\leq \\textbf{flow\\_cap}_\\text{node,tech,carrier}\\\\\n" +
  "    \\quad \\textbf{flow\\_cap}_\\text{node,tech,carrier} \\leq \\textit{flow\\_cap\\_max}_\\text{tech,carrier,node}\\\\\n" +
  "\\end{array}";

describe("renderLatex", () => {
  it("renders a real Calliope constraint with no errors", () => {
    const rendered = renderLatex(BALANCE_CONVERSION);

    expect(rendered.error).toBeNull();
    expect(hasRenderError(rendered)).toBe(false);
    expect(rendered.html).toContain("katex");
  });

  it("renders a variable's domain and bounds", () => {
    const rendered = renderLatex(FLOW_CAP);

    expect(hasRenderError(rendered)).toBe(false);
  });

  it("accepts every command Calliope's backend actually emits", () => {
    // Individually, so a failure names the command rather than the equation.
    // `\(…\)` inside `\text{}` is `mathify_text_in_text`'s output and is the one
    // that would fail without Calliope's own escaping applied first.
    const commands = [
      "a \\negthickspace b",
      "a \\mathord{==} b",
      "a \\!\\! b",
      "\\text{if } x",
      "\\text{a \\(\\text{b}\\) c}",
      "\\in\\mathbb{R}\\;",
      "\\sum\\limits_{\\text{c} \\in \\text{carriers}} (x)",
      "\\begin{array}{l} a \\\\[2em] b \\end{array}",
    ];

    for (const command of commands) {
      expect(hasRenderError(renderLatex(command)), command).toBe(false);
    }
  });

  it("escaped underscores render, unescaped ones do not", () => {
    // The reason `runs/mathdoc.py` borrows Calliope's filters rather than
    // handing on the raw `math_string`: an underscore inside `\text{}` is a
    // subscript request KaTeX cannot honour, and it rejects the whole string.
    expect(hasRenderError(renderLatex("\\textit{base\\_tech}"))).toBe(false);
    expect(hasRenderError(renderLatex("\\textit{base_tech}"))).toBe(true);
  });

  it("degrades to a marked-up error rather than throwing", () => {
    // One bad equation must not take a pane of a hundred down. `\frac{1}` is a
    // genuine parse error — an argument short — which is what `throwOnError:
    // false` turns into markup instead of an exception out of a render function.
    const rendered = renderLatex("\\frac{1}");

    expect(rendered.error).toBeNull();
    expect(hasRenderError(rendered)).toBe(true);
    expect(rendered.html).toContain("katex-error");
  });

  it("shows a command it does not know rather than dropping it", () => {
    // KaTeX 0.18 renders an undefined control sequence as literal text instead
    // of raising, whatever `strict` says — verified, not assumed. That is the
    // right failure for us and worth pinning: the alternative would be an
    // equation quietly missing a term, which reads as correct math and is not.
    const rendered = renderLatex("a \\zzzunknown b");

    expect(rendered.html).toContain("zzzunknown");
  });

  it("emits no markup for an empty or whitespace source", () => {
    // A parameter has a symbol but no equation, so this is the ordinary case.
    expect(renderLatex("").html).toBe("");
    expect(renderLatex("   \n ").html).toBe("");
  });

  it("returns the identical result for a repeated source", () => {
    // Memoised: the list re-renders on every keystroke of the filter.
    const first = renderLatex(BALANCE_CONVERSION);
    const second = renderLatex(BALANCE_CONVERSION);

    expect(second).toBe(first);
  });

  it("does not emit an href, whatever the source asks for", () => {
    // `trust: false` is the security model — see the module docblock. This is
    // the one command that can put an attacker-chosen attribute in the output.
    const rendered = renderLatex("\\href{javascript:alert(1)}{click}");

    expect(rendered.html).not.toContain("javascript:");
    expect(rendered.html).not.toContain("<a ");
  });
});
