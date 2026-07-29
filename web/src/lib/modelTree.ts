import type { ComponentTree } from "../stores/componentTree";

/**
 * Turning the server's component tree into rows the explorer can render.
 *
 * Extracted from the component that used to hold it so it can be tested: the
 * ordering, the `config` special case and the fallback to a section's own file
 * are all easy to break and invisible until a model with the right shape opens.
 */

/** Sections shown, in display order. */
export const SECTIONS = [
  "config",
  "math",
  "data_tables",
  "techs",
  "nodes",
  "links",
  "templates",
  "overrides",
  "scenarios",
] as const;

/**
 * Sections with a structured editor. Anything else opens as raw YAML.
 *
 * `overrides` is here despite an override being an arbitrary partial model: its
 * editor shows the *settings* an override makes, one row per leaf, rather than
 * trying to be the whole editor again recursively.
 *
 * `math` is absent for a different reason from `templates`: it does not open a
 * file at all. A math *source* is a name, and two of the names are Calliope's
 * own base and mode math, which live inside the installed package and have no
 * file in the workspace to open. `ModelSection` routes it to the Math tab
 * before this set is consulted.
 */
export const STRUCTURED_SECTIONS = new Set<string>([
  "config",
  "data_tables",
  "techs",
  "nodes",
  "links",
  "overrides",
  "scenarios",
]);

export interface ModelTreeNode {
  key: string;
  label: string;
  section: string;
  /** The file that defines this, which is what an editor is opened against. */
  file?: string;
  /**
   * Where in that file, for a section that opens as raw YAML.
   *
   * `templates` has no structured editor, so clicking one used to open a file of
   * forty of them at line 1 — which is where the search starts, not where it ends.
   */
  line?: number;
  entryName?: string;
  /** Shown as a badge: most technologies get their base_tech from a template. */
  template?: string;
  /** How many settings an override makes — see modeldef/imports.py. */
  settingCount?: number;
  /** Which overrides a scenario composes. */
  overrides?: string[];
  /** Math sources: whether Calliope reads this one, and what kind it is. */
  mathKind?: "builtin" | "user" | "unknown";
  applied?: boolean;
  missing?: boolean;
  shadowsBuiltin?: boolean;
  /** How many components of each kind a user math file defines. */
  counts?: Record<string, number>;
  children?: ModelTreeNode[];
}

function titleCase(section: string): string {
  return section.replace(/_/g, " ").replace(/^\w/, (first) => first.toUpperCase());
}

export function buildModelTree(tree: ComponentTree | null): ModelTreeNode[] {
  if (!tree) return [];

  const rows: ModelTreeNode[] = [];

  for (const section of SECTIONS) {
    const data = tree[section];
    if (!data) continue;

    // `config` is a single object rather than a list of named entries, so it is
    // a leaf that opens straight into its editor.
    if (section === "config") {
      rows.push({
        key: "config",
        label: "Config",
        section: "config",
        file: data.file,
      });
      continue;
    }

    const children: ModelTreeNode[] = (data.entries ?? []).map((entry) => {
      const name = typeof entry === "string" ? entry : entry.name;
      return {
        key: `${section}:${name}`,
        label: name,
        section,
        // An entry can be defined in a different file from the one that opened
        // the section, so it carries its own; falling back keeps a bare-string
        // entry working.
        file: typeof entry === "string" ? data.file : (entry.file ?? data.file),
        line: typeof entry === "string" ? undefined : entry.line,
        entryName: name,
        template: typeof entry === "string" ? undefined : entry.template,
        settingCount: typeof entry === "string" ? undefined : entry.setting_count,
        overrides: typeof entry === "string" ? undefined : entry.overrides,
        mathKind: typeof entry === "string" ? undefined : entry.kind,
        applied: typeof entry === "string" ? undefined : entry.applied,
        missing: typeof entry === "string" ? undefined : entry.missing,
        shadowsBuiltin:
          typeof entry === "string" ? undefined : entry.shadows_builtin,
        counts: typeof entry === "string" ? undefined : entry.counts,
      };
    });

    rows.push({
      key: section,
      label: titleCase(section),
      section,
      file: data.file,
      children: children.length ? children : undefined,
    });
  }

  return rows;
}
