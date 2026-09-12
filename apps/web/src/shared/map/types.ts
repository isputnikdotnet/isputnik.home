// The vocabulary every map in this app is drawn in — and the whole of it.
//
// Six surfaces used to each build their own Leaflet map by hand (the gallery
// map, the lightbox mini map and its picker, the story map and its route
// picker, the dashboard's sign-in locations). That spread `L.map`, `L.marker`,
// `L.divIcon`, `fitBounds` and `flyTo` across six files, which is what made the
// renderer expensive to change — not the choice of renderer itself.
//
// So features describe WHAT to draw in these terms, `MapView` pushes that at a
// `MapRenderer`, and only the renderer knows the map library. That is how the
// move from Leaflet to MapLibre was one new adapter (maplibre-renderer.ts) and
// not a rewrite of six features — and how the next move would be too.
//
// Deliberately not a general-purpose GIS API: this is exactly what our surfaces
// use and nothing more. Anything a seventh surface needs is added here first.

export type LatLng = [number, number];

/** A point on the map drawn as an HTML badge: a photo thumbnail, a numbered
 *  story stop, a plain dot, the household's home ring. */
export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  /** The icon's class — the look lives in CSS, as it does today. */
  className: string;
  /** Inner HTML of the badge. The CALLER escapes anything user-supplied; the
   *  only values passed today are app-generated markup and escaped labels. */
  html?: string;
  size: [number, number];
  /** Defaults to the centre of `size`, which is what every caller wants. */
  anchor?: [number, number];
  /** Native tooltip, set through the DOM (so quotes in a filename are safe). */
  title?: string;
  /** Hover bubble drawn by the map, above the marker. */
  tooltip?: string;
  draggable?: boolean;
  /** False for decoration that must not swallow a click (route mode badges). */
  interactive?: boolean;
  /** Below 0 to sit under the markers that matter more. */
  zIndex?: number;
  /** Adds `is-selected` to the icon's class. */
  selected?: boolean;
}

/** A bubble whose size carries a number — the dashboard's connection counts. */
export interface MapCircle {
  id: string;
  lat: number;
  lng: number;
  radius: number;
  className: string;
  tooltip?: string;
  selected?: boolean;
}

/** One drawn line: a route leg, followed or straight. */
export interface MapLine {
  id: string;
  points: LatLng[];
  className: string;
  weight: number;
  dashArray?: string;
}

/** Everything on the map right now. Replaced wholesale rather than diffed —
 *  every surface already rebuilt its layer on each change, and a handful of
 *  shapes is cheaper to redraw than to reconcile. */
export interface MapShapes {
  markers?: MapMarker[];
  circles?: MapCircle[];
  lines?: MapLine[];
}

/** Where the map should be looking. Applied when the command's identity
 *  changes, so callers decide with `useMemo` exactly when the view moves —
 *  which matters: the gallery map reframes on every result set, while the route
 *  picker frames once and then belongs to the author. */
export type MapViewCommand =
  /** Straight to a point. */
  | { kind: "center"; center: LatLng; zoom?: number }
  /** Frame these points. */
  | {
      kind: "fit";
      points: LatLng[];
      pad?: number;
      maxZoom?: number;
      /** False to jump rather than glide: there is no earlier view to keep
       *  one's bearings from, and an animation frozen in a hidden tab would
       *  strand the map on its opening view. */
      animate?: boolean;
      /** Wait a tick and re-measure first — for a map framed while its dialog
       *  is still 0×0, where fitting now lands on the whole world. */
      defer?: boolean;
      /** One point has no extent; fitting it would pick the maximum zoom. */
      single?: { zoom: number };
      /** No points at all. */
      empty?: { center: LatLng; zoom: number };
    }
  /** Move there with an animation, because the reader has a view to keep
   *  their bearings from. */
  | {
      kind: "fly";
      points: LatLng[];
      maxZoom?: number;
      /** Never zoom OUT past this when flying to a single point. */
      minZoom?: number;
      duration?: number;
    };

/** Zoom levels throughout this vocabulary are on the RASTER scale (256 px
 *  tiles), the one the app has always used: 14 frames a photo's street, 2 the
 *  world. A renderer on another scale translates — MapLibre, on 512 px tiles,
 *  shows at z the area raster shows at z + 1. Callers never think about it. */
export interface MapOptions {
  center: LatLng;
  zoom: number;
  minZoom?: number;
  /** Off wherever the map sits inside something scrollable. */
  scrollWheelZoom?: boolean;
  worldCopyJump?: boolean;
  cluster?: boolean;
  clusterRadius?: number;
  /** A guest's share link, which every map request must carry. Set by MapView
   *  from MapShareContext, never by a feature. */
  share?: string;
}

/** Longitudes are folded back into ±180 before they reach a handler: a point
 *  picked on a panned-past-the-antimeridian world copy is otherwise out of the
 *  range the server insists on. */
export interface MapHandlers {
  onMapClick?: (point: { lat: number; lng: number }) => void;
  onMarkerClick?: (id: string) => void;
  onMarkerDragEnd?: (id: string, point: { lat: number; lng: number }) => void;
  onCircleClick?: (id: string) => void;
}

/** The one interface a renderer implements. `MapView` is its only caller, and
 *  handlers stay live for the map's lifetime (it passes stable trampolines), so
 *  an implementation never has to think about stale callbacks. */
export interface MapRenderer {
  mount(container: HTMLElement, options: MapOptions, handlers: MapHandlers): void;
  setShapes(shapes: MapShapes): void;
  applyView(view: MapViewCommand): void;
  /** An extra credit earned by what was drawn — routing, say. The base map's own
   *  credit comes with its style. Idempotent. */
  addAttribution(html: string): void;
  destroy(): void;
}
