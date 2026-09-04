import type { GeoSource } from "@/composables/useModelGeo";

/** What the map's status banner says, if it says anything. */
export interface GeoStatus {
  tone: "info" | "warning" | "danger";
  text: string;
  /** Calliope's own complaint, where there is one. */
  detail?: string;
}

/**
 * Turns the server's account of where the geography came from into words.
 *
 * `/geo/` answers with the best reading it has and says which one that is —
 * `resolved` (the files as they are now, through Calliope), `stale` (an earlier
 * resolution, kept while the current files rebuild or refuse to load) or
 * `structural` (the YAML alone, because Calliope has never read this model).
 * The server's own note on `stale` is that the last good answer is worth
 * showing *as long as it is labelled*; this is the label.
 *
 * Nothing is said while a resolve is running: that is every save for a few
 * seconds, and a banner appearing and vanishing after each one is noise where a
 * hairline says the same thing. The settled states are the ones worth a line,
 * and the one with Calliope's complaint attached is the one worth reading.
 */
export function geoStatus(
  source: GeoSource,
  resolving: boolean,
  error: string | null,
): GeoStatus | null {
  if (source === "resolved") {
    return error ? { tone: "warning", text: "Calliope could not re-read the files:", detail: error } : null;
  }
  if (resolving) {
    return source === "structural"
      ? { tone: "info", text: "Showing positions as written, while Calliope reads the model." }
      : null;
  }
  if (source === "stale") {
    return error
      ? {
          tone: "warning",
          text: "Showing the last reading Calliope could build. The current files do not load:",
          detail: error,
        }
      : { tone: "info", text: "Showing the last reading Calliope could build." };
  }
  return error
    ? { tone: "danger", text: "Showing positions as written only. Calliope cannot read the model:", detail: error }
    : { tone: "info", text: "Showing positions as written. Calliope has not read this model." };
}
