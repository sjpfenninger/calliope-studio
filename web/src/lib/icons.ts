import {
  ArrowLeftRight,
  BarChart3,
  Copy,
  File,
  FileArchive,
  FileCode2,
  FileText,
  Folder,
  Image,
  List,
  Map,
  MapPin,
  Settings2,
  Sigma,
  SlidersVertical,
  Table2,
  Zap,
  type LucideIcon,
} from "@lucide/vue";

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
 * beside 12px text. It is set once, globally, by `setLucideProps` in App.vue, so
 * you should never need to pass it: an icon that says nothing gets 1.75.
 */
export const ICON_STROKE_WIDTH = 1.75;

/**
 * For glyphs drawn below 14px — a chevron at `size-3`, the tick inside a
 * checkbox. 1.75 at that scale renders under a device pixel and the glyph
 * thins out to nothing, so these are the one legitimate override.
 */
export const ICON_STROKE_WIDTH_TIGHT = 2.5;

const SECTION_ICONS: Record<string, LucideIcon> = {
  config: Settings2,
  math: Sigma,
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
  if (type === "markdown") return FileText;
  if (type === "image") return Image;
  if (type === "binary") return FileArchive;
  if (type === "directory") return Folder;
  return File;
}

export { BarChart3 as RunIcon, Map as MapIcon, Sigma as MathIcon };
