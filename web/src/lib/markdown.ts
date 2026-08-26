/**
 * Markdown → HTML, for the file viewer.
 *
 * **`html: false` is the security model**, not a stylistic choice. It escapes
 * raw HTML in the source rather than passing it through, which is what makes a
 * sanitizer unnecessary: there is no untrusted markup to sanitize, because none
 * of it survives the parse. DOMPurify would be a second runtime dependency and a
 * second thing that has to stay correct, for a viewer whose entire job is
 * showing a README. markdown-it's own `validateLink` covers the other half,
 * rejecting `javascript:`, `vbscript:` and `file:` URLs.
 *
 * GFM comes almost free: tables, strikethrough and fenced code are in
 * markdown-it's default preset, and `linkify` turns a bare URL into a link. Task
 * lists are the one part that is not, and are done below rather than with
 * `markdown-it-task-lists` — that is a dependency with no type declarations for
 * a rule that fits on a screen.
 *
 * Not attempted: footnotes (not GFM), and resolving a relative link to another
 * file in the model, which would need the tree and a router hop.
 */
import MarkdownIt, { type Token } from "markdown-it";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  // Off: it turns `--` into an en dash and quotes into curly ones, which is
  // wrong inside the prose of a technical README that talks about CLI flags.
  typographer: false,
});

/**
 * GFM task lists: `- [ ] thing` and `- [x] thing`.
 *
 * Matched on the inline token's raw content rather than by re-lexing, and only
 * for a list item whose *first* child is the paragraph — so a `[x]` appearing
 * mid-sentence, or in a paragraph of its own, is left as the text it is.
 *
 * The checkbox is `disabled`: the preview renders a file, and a control that
 * looks clickable but changes nothing on disk is worse than one that says so.
 */
md.core.ruler.push("task_lists", (state) => {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== "list_item_open") continue;
    // list_item_open, paragraph_open, inline
    const inline = tokens[i + 2];
    if (!inline || inline.type !== "inline" || tokens[i + 1].type !== "paragraph_open") {
      continue;
    }
    const match = /^\[([ xX])\]\s+/.exec(inline.content);
    if (!match) continue;

    const checked = match[1] !== " ";
    inline.content = inline.content.slice(match[0].length);
    // The inline token has already been tokenised by the `inline` rule that runs
    // before this one, so its children are what actually render. Trimming
    // `content` alone would change nothing.
    const first = inline.children?.[0];
    if (first && first.type === "text") {
      first.content = first.content.replace(/^\[[ xX]\]\s+/, "");
    }

    const checkbox = new state.Token("html_inline", "", 0);
    checkbox.content = `<input class="cg-task" type="checkbox" disabled${
      checked ? " checked" : ""
    }> `;
    inline.children?.unshift(checkbox);

    tokens[i].attrJoin("class", "cg-task-item");
  }
  return true;
});

/**
 * A link out of the app opens in a new tab.
 *
 * Without `rel`, the opened page gets a handle on `window.opener`. Modern
 * browsers imply `noopener` for `target="_blank"`, but the file viewer is not
 * the place to depend on that.
 */
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens: Token[], idx: number, options, _env, self) =>
    self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  // markdown-it types an attribute value as `string | number`, so a link
  // whose href parsed as a number would not be a string here.
  const href = String(tokens[idx].attrGet("href") ?? "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    tokens[idx].attrSet("target", "_blank");
    tokens[idx].attrSet("rel", "noopener noreferrer");
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

export function renderMarkdown(source: string): string {
  return md.render(source);
}
