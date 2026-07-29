/**
 * The markdown renderer, and chiefly the two things it must never do.
 *
 * This is the first place in the app where file content reaches the DOM as
 * markup rather than as text — `v-html` appears exactly once elsewhere, over
 * SVG the app generated itself. There is no sanitizer behind it, deliberately:
 * `html: false` means there is nothing to sanitize. These tests are what says
 * that is still true.
 */
import { describe, expect, it } from "vitest";

import { renderMarkdown } from "./markdown";

describe("safety", () => {
  it("escapes raw HTML rather than passing it through", () => {
    const html = renderMarkdown("<script>alert(1)</script>\n");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes an inline event handler on an escaped tag", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">\n');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("makes no link at all out of a javascript: URL", () => {
    // markdown-it's own `validateLink` rejects the scheme, and rejecting it
    // means the link syntax is not recognised — so the whole thing stays as the
    // escaped text it was written as. What matters is that no anchor exists to
    // carry the href; the characters appearing in a paragraph are inert.
    const html = renderMarkdown("[click](javascript:alert(1))\n");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href");
  });

  it("opens an external link safely in a new tab", () => {
    const html = renderMarkdown("[calliope](https://calliope.readthedocs.io)\n");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("leaves a relative link alone", () => {
    // Nothing resolves these yet, so they must not be given a new tab either.
    const html = renderMarkdown("[techs](model_config/techs.yaml)\n");
    expect(html).not.toContain('target="_blank"');
  });
});

describe("GFM", () => {
  it("renders a table", () => {
    const html = renderMarkdown("| a | b |\n| - | - |\n| 1 | 2 |\n");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>2</td>");
  });

  it("renders strikethrough", () => {
    expect(renderMarkdown("~~gone~~\n")).toContain("<s>gone</s>");
  });

  it("linkifies a bare URL", () => {
    expect(renderMarkdown("see https://example.com now\n")).toContain(
      '<a href="https://example.com"',
    );
  });

  it("keeps the language on a fenced block, for highlighting later", () => {
    expect(renderMarkdown("```yaml\nconfig: {}\n```\n")).toContain("language-yaml");
  });
});

describe("task lists", () => {
  it("renders an unchecked box", () => {
    const html = renderMarkdown("- [ ] not done\n");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("disabled");
    expect(html).not.toContain("checked");
    expect(html).toContain("not done");
    expect(html).not.toContain("[ ]");
  });

  it("renders a checked box for both spellings", () => {
    expect(renderMarkdown("- [x] done\n")).toContain("checked");
    expect(renderMarkdown("- [X] done\n")).toContain("checked");
  });

  it("leaves brackets mid-sentence alone", () => {
    // The rule matches the start of a list item's first paragraph and nothing
    // else, so ordinary prose about arrays is not turned into a control.
    const html = renderMarkdown("- an array like [ x ] stays text\n");
    expect(html).not.toContain("checkbox");
  });

  it("leaves a bracket in a plain paragraph alone", () => {
    expect(renderMarkdown("[ ] not a list\n")).not.toContain("checkbox");
  });
});
