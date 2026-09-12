import { createMapLibreRenderer } from "./maplibre-renderer";
import type { MapRenderer } from "./types";

// Which renderer the app's maps are drawn with — THE seam, and deliberately a
// file of its own so that swapping one for another is a one-line change here
// plus a new adapter, rather than an edit to every map in the app.
//
// Tests reach the same seam by mocking this module, which is why `MapView`
// calls it instead of importing an adapter directly: a map test then needs no
// knowledge of the renderer at all.
export function createRenderer(): MapRenderer {
  return createMapLibreRenderer();
}
