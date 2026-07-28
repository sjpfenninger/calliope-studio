import { describe, expect, it } from "vitest";

import { donutSvg, escapeText, wedgePath, wedges } from "./pieMarker";

describe("wedgePath", () => {
  it("starts a wedge at twelve o'clock and sweeps clockwise", () => {
    // A quarter from the top ends at three o'clock: +x, y still 0.
    const path = wedgePath(0, 0.25, 10, 5);
    expect(path.startsWith("M 0 -10")).toBe(true);
    expect(path).toContain("A 10 10 0 0 1 10 0");
  });

  it("sets the large-arc flag past a half turn", () => {
    expect(wedgePath(0, 0.75, 10, 5)).toContain("A 10 10 0 1 1");
    expect(wedgePath(0, 0.4, 10, 5)).toContain("A 10 10 0 0 1");
  });

  it("draws a whole circle as two arcs", () => {
    // One arc whose start and end coincide renders nothing at all, and a node
    // with a single technology is the common case on a small model.
    const path = wedgePath(0, 1, 10, 5);
    expect(path.match(/A /g)).toHaveLength(4);
    expect(path).toContain("M 0 -10");
    expect(path).toContain("M 0 -5");
  });
});

describe("wedges", () => {
  it("splits by share and carries the colour through", () => {
    const drawn = wedges(
      [
        { key: "pv", value: 3, color: "#aaaaaa" },
        { key: "ccgt", value: 1 },
      ],
      10,
      5,
      "#000000",
    );
    expect(drawn.map((wedge) => wedge.share)).toEqual([0.75, 0.25]);
    expect(drawn[0].color).toBe("#aaaaaa");
    // A slice the server had no colour for still occupies its share; dropping it
    // would silently inflate every other wedge.
    expect(drawn[1].color).toBe("#000000");
  });

  it("returns nothing when there is nothing to divide", () => {
    expect(wedges([], 10, 5, "#000000")).toEqual([]);
    expect(wedges([{ key: "a", value: 0 }], 10, 5, "#000000")).toEqual([]);
  });
});

describe("donutSvg", () => {
  const options = {
    radius: 10,
    stroke: "#ffffff",
    strokeWidth: 1,
    fallbackColor: "#000000",
  };

  it("sizes the viewport to the radius and stroke", () => {
    const svg = donutSvg([{ key: "pv", value: 1 }], options);
    expect(svg).toContain('width="22" height="22"');
    expect(svg).toContain('viewBox="0 0 22 22"');
    expect(svg).toContain("translate(11 11)");
  });

  it("draws one path per slice", () => {
    const svg = donutSvg(
      [
        { key: "pv", value: 1, color: "#aaaaaa" },
        { key: "ccgt", value: 1, color: "#bbbbbb" },
      ],
      options,
    );
    expect(svg.match(/<path /g)).toHaveLength(2);
    expect(svg).toContain('fill="#aaaaaa"');
    expect(svg).toContain('fill-rule="evenodd"');
  });

  it("escapes the label it is given", () => {
    const svg = donutSvg([{ key: "a", value: 1 }], {
      ...options,
      label: 'region<1> & "two"',
    });
    expect(svg).toContain("<title>region&lt;1&gt; &amp; &quot;two&quot;</title>");
    expect(svg).not.toContain("<1>");
  });
});

describe("escapeText", () => {
  it("neutralises everything that could close the tag", () => {
    expect(escapeText(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&#39;");
  });
});
