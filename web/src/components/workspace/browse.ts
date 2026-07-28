/**
 * What `GET /api/browse/` returns.
 *
 * A module rather than an export from `FolderBrowser.vue`, because a
 * `<script setup>` block cannot carry `export` statements — and because the two
 * dialogs that hold a listing between openings need the type without needing
 * the component.
 */

export interface BrowseEntry {
  name: string;
  path: string;
  is_model: boolean;
}

export interface Listing {
  path: string;
  parent: string | null;
  /** Whether this folder itself contains a `model.yaml`. */
  is_model: boolean;
  entries: BrowseEntry[];
  /** True when the server capped the listing; see `browse.MAX_ENTRIES`. */
  truncated: boolean;
}
