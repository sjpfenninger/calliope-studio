import {
  ArrowLeftRight,
  BarChart3,
  Copy,
  File,
  FileCode2,
  Folder,
  List,
  Map,
  MapPin,
  Settings2,
  SlidersVertical,
  Table2,
  Zap,
  type LucideIcon,
} from "lucide-vue-next";

/**
 * Icons, in one place.
 *
 * The section-to-icon map used to be duplicated across three components, which
 * meant a section could be a bolt in the tree and a folder in the tab bar. They
 * are also components rather than class-name strings now: the previous icon font
 * was 40 kB loaded for two dozen glyphs, where lucide tree-shakes to the ones
 * actually used.
 *
 * Stroke width 1.75 rather than lucide's default 2 — the default reads heavy
 * beside 12px text.
 */
export const ICON_STROKE_WIDTH = 1.75;

const SECTION_ICONS: Record<string, LucideIcon> = {
  config: Settings2,
  data_tables: Table2,
  techs: Zap,
  nodes: MapPin,
  links: ArrowLeftRight,
  templates: Copy,
  overrides: SlidersVertical,
  scenarios: List,
};

export function sectionIcon(section: string): LucideIcon {
  return SECTION_ICONS[section] ?? Folder;
}

export function fileIcon(type: string): LucideIcon {
  if (type === "csv") return Table2;
  if (type === "yaml") return FileCode2;
  if (type === "directory") return Folder;
  return File;
}

export { BarChart3 as RunIcon, Map as MapIcon };
