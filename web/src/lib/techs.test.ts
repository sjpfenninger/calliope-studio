import { describe, expect, it } from "vitest";
import { isTransmission, mergeIntoSection, ownedNames } from "./techs";

/**
 * TechsEditor and LinksEditor each show half of one YAML section and each save
 * the whole of it. If the merge is wrong, saving from one silently deletes
 * every entry belonging to the other — straight into the user's model file.
 */

const TEMPLATES = {
  free_transmission: { base_tech: "transmission", carrier_in: "power" },
  standard_supply: { base_tech: "supply" },
};

describe("isTransmission", () => {
  it("recognises an explicit base_tech", () => {
    expect(isTransmission({ base_tech: "transmission" })).toBe(true);
  });

  it("resolves base_tech through a template", () => {
    // How most links in the example models are defined.
    expect(
      isTransmission({ template: "free_transmission" }, TEMPLATES),
    ).toBe(true);
  });

  it("accepts endpoints alone when the template is unknown", () => {
    expect(isTransmission({ link_from: "a", link_to: "b" })).toBe(true);
  });

  it("needs both endpoints", () => {
    expect(isTransmission({ link_from: "a" })).toBe(false);
  });

  it("rejects ordinary technologies", () => {
    expect(isTransmission({ base_tech: "supply" })).toBe(false);
    expect(isTransmission({ template: "standard_supply" }, TEMPLATES)).toBe(false);
    expect(isTransmission(null)).toBe(false);
    expect(isTransmission({})).toBe(false);
  });
});


describe("mergeIntoSection", () => {
  const original = {
    ccgt: { base_tech: "supply", flow_cap_max: 100 },
    a_to_b: { base_tech: "transmission", link_from: "a", link_to: "b" },
    battery: { base_tech: "storage" },
  };
  const isLink = (name: string) => name === "a_to_b";
  const isNotLink = (name: string) => name !== "a_to_b";

  it("saving from the techs editor keeps the links", () => {
    const merged = mergeIntoSection(
      original,
      { ccgt: { base_tech: "supply", flow_cap_max: 200 }, battery: { base_tech: "storage" } },
      isNotLink,
    );
    expect(merged.a_to_b).toEqual(original.a_to_b);
    expect(merged.ccgt).toEqual({ base_tech: "supply", flow_cap_max: 200 });
  });

  it("saving from the links editor keeps the technologies", () => {
    const merged = mergeIntoSection(
      original,
      { a_to_b: { base_tech: "transmission", link_from: "a", link_to: "z" } },
      isLink,
    );
    expect(merged.ccgt).toEqual(original.ccgt);
    expect(merged.battery).toEqual(original.battery);
    expect(merged.a_to_b).toEqual({
      base_tech: "transmission",
      link_from: "a",
      link_to: "z",
    });
  });

  it("preserves the original key order", () => {
    const merged = mergeIntoSection(
      original,
      { battery: { base_tech: "storage" }, ccgt: { base_tech: "supply" } },
      isNotLink,
    );
    // Reordering the section would rewrite the file for no reason.
    expect(Object.keys(merged)).toEqual(["ccgt", "a_to_b", "battery"]);
  });

  it("deletes an owned entry the editor removed", () => {
    const merged = mergeIntoSection(original, { ccgt: original.ccgt }, isNotLink);
    expect(merged).not.toHaveProperty("battery");
    expect(merged).toHaveProperty("a_to_b");
  });

  it("never deletes an entry the editor does not own", () => {
    // The links editor showing nothing must not wipe the technologies.
    const merged = mergeIntoSection(original, {}, isLink);
    expect(Object.keys(merged)).toEqual(["ccgt", "battery"]);
  });

  it("appends new entries at the end", () => {
    const merged = mergeIntoSection(
      original,
      { ...original, solar: { base_tech: "supply" } },
      isNotLink,
    );
    expect(Object.keys(merged)).toEqual(["ccgt", "a_to_b", "battery", "solar"]);
  });
});

/**
 * Which of the two editors owns an entry is decided when the section loads, and
 * must not be re-derived from what a save wrote.
 *
 * `isTransmission` reads `base_tech`, and the techs form can *set* it. Asking
 * the question against the just-written section therefore answered "not mine"
 * for a row still on screen and still in the editor's list, so `mergeIntoSection`
 * passed the pre-edit original through and every later edit to that row went
 * into the void — with the tab marked clean each time.
 */
describe("ownedNames", () => {
  const section: Record<string, Record<string, unknown>> = {
    ccgt: { base_tech: "supply" },
    battery: { base_tech: "storage" },
    ac_line: { base_tech: "transmission", link_from: "a", link_to: "b" },
    inherited_line: { template: "free_transmission" },
  };

  it("splits a section into the two editors' halves", () => {
    expect(ownedNames(section, TEMPLATES, "techs")).toEqual(
      new Set(["ccgt", "battery"]),
    );
    expect(ownedNames(section, TEMPLATES, "links")).toEqual(
      new Set(["ac_line", "inherited_line"]),
    );
  });

  it("gives every entry to exactly one of them", () => {
    const techs = ownedNames(section, TEMPLATES, "techs");
    const links = ownedNames(section, TEMPLATES, "links");
    expect(techs.size + links.size).toBe(Object.keys(section).length);
    expect([...techs].filter((name) => links.has(name))).toEqual([]);
  });

  it("keeps an entry whose base_tech was changed to transmission", () => {
    // The load-time answer, held across the save that made it a link.
    const owned = ownedNames(section, TEMPLATES, "techs");
    const written: Record<string, Record<string, unknown>> = {
      ...section,
      ccgt: { base_tech: "transmission" },
    };

    const merged = mergeIntoSection(
      written,
      { ccgt: { base_tech: "transmission", flow_cap_max: 100 } },
      (name) => owned.has(name),
    );
    expect(merged.ccgt).toEqual({ base_tech: "transmission", flow_cap_max: 100 });

    // Asking the *section* instead is what dropped the edit.
    const stale = mergeIntoSection(
      written,
      { ccgt: { base_tech: "transmission", flow_cap_max: 100 } },
      (name) => !isTransmission(written[name] ?? null, TEMPLATES),
    );
    expect(stale.ccgt).toEqual({ base_tech: "transmission" });
  });
});
