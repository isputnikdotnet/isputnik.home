import {
  AttributionControl,
  Map as GlMap,
  Marker,
  Popup,
  setWorkerUrl,
  type GeoJSONSource,
  type StyleSpecification
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre 6 looks for its worker beside its own bundle, which Vite neither
// emits nor serves; left alone, every map is a blank rectangle. Vite bundles the
// worker (and what it imports) as a file of its own and gives us its URL.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import i18n from "../../i18n";
import { dashFor, glZoom, paddedBounds, toLngLat } from "./maplibre-geometry";
import { isDarkTheme, loadMapConfig, loadMapStyle } from "./map-style";
import type { MapCircle, MapHandlers, MapMarker, MapOptions, MapRenderer, MapShapes, MapViewCommand } from "./types";

// MapLibre behind the MapRenderer interface. THE ONLY FILE IN THE APP THAT
// IMPORTS MAPLIBRE — keep it that way; a feature reaching for it directly puts
// the renderer back into six files (see types.ts).
//
// What it had to preserve from the Leaflet adapter it replaced, and how:
//  - Markers, circles and their CSS. Markers are HTML, as Leaflet's divIcons
//    were; circles are an SVG <circle> inside an HTML marker, so the existing
//    fill/stroke/hover rules apply unchanged.
//  - Lines. These must follow the ground as the map zooms, so they are WebGL
//    layers — which CSS cannot reach. Their colour is READ from CSS instead,
//    through a hidden probe carrying the line's class, so the theme still owns it.
//  - Clusters, for the gallery's thumbnails: a clustered GeoJSON source, with
//    HTML markers kept in step with whatever it says is on screen.
//  - The raster zoom scale callers use (maplibre-geometry.ts translates).
//
// And what it adds: a dark basemap on a dark theme, swapped live when the theme
// changes, and labels in the interface language (map-style.ts).

const SVG = "http://www.w3.org/2000/svg";
const CLUSTER_SOURCE = "vocab-cluster";

let workerReady = false;

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

/** A plain sentence in the map's place. The adapter is not React, so this is
 *  DOM; the look is `.map-notice` in CSS. */
function showNotice(container: HTMLElement, text: string): void {
  const notice = document.createElement("div");
  notice.className = "map-notice";
  notice.setAttribute("role", "status");
  notice.textContent = text;
  container.appendChild(notice);
}

function markerClass(className: string, selected: boolean | undefined): string {
  return selected ? `${className} is-selected` : className;
}

export function createMapLibreRenderer(): MapRenderer {
  let map: GlMap | null = null;
  let container: HTMLElement | null = null;
  let options: MapOptions | null = null;
  let handlers: MapHandlers = {};
  let destroyed = false;
  let styleReady = false;
  let loaded = false;
  let dark = false;
  let shapes: MapShapes = {};
  let pendingView: MapViewCommand | null = null;
  let attribution: AttributionControl | null = null;
  let themeObserver: MutationObserver | null = null;
  let probe: SVGPathElement | null = null;
  let refreshQueued = false;
  const credits = new Set<string>();
  const timers = new Set<number>();
  // Everything drawn as HTML, each with what removing it has to undo.
  let drawn: { marker: Marker; dispose: () => void }[] = [];
  const clusterDrawn = new Map<string, { marker: Marker; dispose: () => void }>();
  const clusterSpecs = new Map<string, MapMarker>();
  let lineIds: string[] = [];

  const later = (fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
  };

  // --- HTML markers --------------------------------------------------------

  /** Hover bubble. Text, never HTML: a filename or a place name goes in as-is. */
  function withTooltip(element: HTMLElement, marker: Marker, text: string | undefined): () => void {
    if (!text) return () => {};
    let popup: Popup | null = null;
    const show = () => {
      if (!map) return;
      popup = new Popup({ closeButton: false, closeOnClick: false, className: "map-tooltip", offset: 14 })
        .setLngLat(marker.getLngLat())
        .setText(text)
        .addTo(map);
    };
    const hide = () => {
      popup?.remove();
      popup = null;
    };
    element.addEventListener("mouseenter", show);
    element.addEventListener("mouseleave", hide);
    return hide;
  }

  function placeMarker(spec: MapMarker): { marker: Marker; dispose: () => void } {
    const element = document.createElement("div");
    element.className = markerClass(spec.className, spec.selected);
    element.style.width = `${spec.size[0]}px`;
    element.style.height = `${spec.size[1]}px`;
    // Decoration (a route's mode badge) sits under what can be clicked. Not a
    // negative z-index: that would put it behind the map canvas itself.
    element.style.zIndex = spec.zIndex !== undefined && spec.zIndex < 0 ? "1" : "2";
    if (spec.html) element.innerHTML = spec.html;
    // Through the DOM, so a filename with quotes in it cannot break out.
    if (spec.title) element.title = spec.title;
    if (spec.interactive === false) element.style.pointerEvents = "none";

    const [width, height] = spec.size;
    const [ax, ay] = spec.anchor ?? [width / 2, height / 2];
    const marker = new Marker({
      element,
      anchor: "center",
      offset: [width / 2 - ax, height / 2 - ay],
      draggable: Boolean(spec.draggable)
    }).setLngLat(toLngLat([spec.lat, spec.lng]));

    element.addEventListener("click", (event) => {
      // A marker's click is the marker's; the map must not also see a click at
      // that spot (a picker would drop a stop under the one you meant to open).
      event.stopPropagation();
      handlers.onMarkerClick?.(spec.id);
    });
    if (spec.draggable) {
      marker.on("dragend", () => {
        const at = marker.getLngLat().wrap();
        handlers.onMarkerDragEnd?.(spec.id, { lat: at.lat, lng: at.lng });
      });
    }
    const hide = withTooltip(element, marker, spec.tooltip);
    if (map) marker.addTo(map);
    return { marker, dispose: () => { hide(); marker.remove(); } };
  }

  function placeCircle(spec: MapCircle): { marker: Marker; dispose: () => void } {
    // Room for the widest stroke the CSS gives a selected bubble.
    const pad = 3;
    const size = spec.radius * 2 + pad * 2;
    const element = document.createElement("div");
    element.className = "map-circle";
    element.style.width = `${size}px`;
    element.style.height = `${size}px`;
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    const circle = document.createElementNS(SVG, "circle");
    circle.setAttribute("class", markerClass(spec.className, spec.selected));
    circle.setAttribute("cx", String(size / 2));
    circle.setAttribute("cy", String(size / 2));
    circle.setAttribute("r", String(spec.radius));
    svg.appendChild(circle);
    element.appendChild(svg);

    const marker = new Marker({ element, anchor: "center" }).setLngLat(toLngLat([spec.lat, spec.lng]));
    circle.addEventListener("click", (event) => {
      event.stopPropagation();
      handlers.onCircleClick?.(spec.id);
    });
    const hide = withTooltip(element, marker, spec.tooltip);
    if (map) marker.addTo(map);
    return { marker, dispose: () => { hide(); marker.remove(); } };
  }

  function drawHtml(): void {
    for (const item of drawn) item.dispose();
    drawn = [];
    if (!map) return;
    if (!options?.cluster) {
      for (const spec of shapes.markers ?? []) drawn.push(placeMarker(spec));
    }
    for (const spec of shapes.circles ?? []) drawn.push(placeCircle(spec));
  }

  // --- Clusters --------------------------------------------------------------

  function clusterBubble(clusterId: number, count: number, lngLat: [number, number]) {
    const size = count < 10 ? "small" : count < 100 ? "medium" : "large";
    const element = document.createElement("div");
    element.className = `map-cluster map-cluster-${size}`;
    const label = document.createElement("span");
    label.textContent = String(count);
    element.appendChild(label);
    const marker = new Marker({ element, anchor: "center" }).setLngLat(lngLat);
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      const source = map?.getSource(CLUSTER_SOURCE) as GeoJSONSource | undefined;
      void source?.getClusterExpansionZoom(clusterId).then((zoom) => {
        map?.easeTo({ center: lngLat, zoom });
      });
    });
    if (map) marker.addTo(map);
    return { marker, dispose: () => marker.remove() };
  }

  /** Put an HTML marker on every cluster and lone point now on screen, and take
   *  away the ones that are not. Called on render, at most once a frame. */
  function refreshClusters(): void {
    refreshQueued = false;
    if (!map || !styleReady || !options?.cluster || !map.getSource(CLUSTER_SOURCE)) return;
    const seen = new Set<string>();
    for (const feature of map.querySourceFeatures(CLUSTER_SOURCE)) {
      const props = feature.properties ?? {};
      const geometry = feature.geometry;
      if (geometry.type !== "Point") continue;
      const lngLat = geometry.coordinates as [number, number];
      // The same feature comes back once per tile it touches.
      const key = props.cluster ? `c${props.cluster_id}` : `p${props.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (clusterDrawn.has(key)) continue;
      if (props.cluster) {
        clusterDrawn.set(key, clusterBubble(Number(props.cluster_id), Number(props.point_count), lngLat));
      } else {
        const spec = clusterSpecs.get(String(props.id));
        if (spec) clusterDrawn.set(key, placeMarker(spec));
      }
    }
    for (const [key, item] of clusterDrawn) {
      if (!seen.has(key)) {
        item.dispose();
        clusterDrawn.delete(key);
      }
    }
  }

  function queueRefresh(): void {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(refreshClusters);
  }

  function clearClusters(): void {
    for (const item of clusterDrawn.values()) item.dispose();
    clusterDrawn.clear();
  }

  function installCluster(): void {
    if (!map || !options?.cluster) return;
    clusterSpecs.clear();
    for (const spec of shapes.markers ?? []) clusterSpecs.set(spec.id, spec);
    const data = {
      type: "FeatureCollection" as const,
      features: (shapes.markers ?? []).map((spec) => ({
        type: "Feature" as const,
        properties: { id: spec.id },
        geometry: { type: "Point" as const, coordinates: toLngLat([spec.lat, spec.lng]) }
      }))
    };
    const source = map.getSource(CLUSTER_SOURCE) as GeoJSONSource | undefined;
    if (source) {
      source.setData(data);
    } else {
      map.addSource(CLUSTER_SOURCE, {
        type: "geojson",
        data,
        cluster: true,
        // Screen pixels, as markercluster's radius was, so photos gather the same.
        clusterRadius: options.clusterRadius ?? 50,
        clusterMaxZoom: 15
      });
      // Invisible, but a source with no layer is never loaded — and an unloaded
      // source has no features to ask about.
      map.addLayer({
        id: `${CLUSTER_SOURCE}-anchor`,
        type: "circle",
        source: CLUSTER_SOURCE,
        paint: { "circle-radius": 1, "circle-opacity": 0, "circle-stroke-opacity": 0 }
      });
    }
    clearClusters();
    queueRefresh();
  }

  // --- Lines -----------------------------------------------------------------

  /** A line's look, read from the CSS its class is given there. */
  function strokeOf(className: string) {
    if (!probe && container) {
      const svg = document.createElementNS(SVG, "svg");
      svg.setAttribute("aria-hidden", "true");
      svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
      probe = document.createElementNS(SVG, "path");
      svg.appendChild(probe);
      container.appendChild(svg);
    }
    probe?.setAttribute("class", className);
    const computed = probe ? getComputedStyle(probe) : null;
    const color = computed?.stroke && computed.stroke !== "none" ? computed.stroke : "#2f9e8f";
    const opacity = Number.parseFloat(computed?.strokeOpacity ?? "1");
    return {
      color,
      opacity: Number.isFinite(opacity) ? opacity : 1,
      round: computed?.strokeLinecap === "round"
    };
  }

  function drawLines(): void {
    if (!map || !styleReady) return;
    for (const id of lineIds) {
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
    }
    lineIds = [];
    (shapes.lines ?? []).forEach((line, index) => {
      const id = `vocab-line-${index}`;
      const look = strokeOf(line.className);
      const dash = dashFor(line.dashArray, line.weight);
      map!.addSource(id, {
        type: "geojson",
        data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line.points.map(toLngLat) } }
      });
      map!.addLayer({
        id,
        type: "line",
        source: id,
        layout: { "line-cap": look.round ? "round" : "butt", "line-join": look.round ? "round" : "miter" },
        paint: {
          "line-color": look.color,
          "line-opacity": look.opacity,
          "line-width": line.weight,
          ...(dash ? { "line-dasharray": dash } : {})
        }
      });
      lineIds.push(id);
    });
  }

  // --- The view ----------------------------------------------------------------

  function doView(view: MapViewCommand): void {
    if (!map) return;
    const active = map;
    if (view.kind === "center") {
      active.jumpTo({ center: toLngLat(view.center), ...(view.zoom === undefined ? {} : { zoom: glZoom(view.zoom) }) });
      return;
    }
    if (view.kind === "fly") {
      if (view.points.length === 0) return;
      const duration = (view.duration ?? 0.6) * 1000;
      if (view.points.length === 1) {
        const floor = view.minZoom === undefined ? active.getZoom() : glZoom(view.minZoom);
        active.flyTo({ center: toLngLat(view.points[0]), zoom: Math.max(active.getZoom(), floor), duration });
        return;
      }
      const bounds = paddedBounds(view.points, 0.4);
      if (bounds) active.fitBounds(bounds, { ...(view.maxZoom === undefined ? {} : { maxZoom: glZoom(view.maxZoom) }), duration });
      return;
    }
    const fit = () => {
      if (view.points.length === 0) {
        if (view.empty) active.jumpTo({ center: toLngLat(view.empty.center), zoom: glZoom(view.empty.zoom) });
        return;
      }
      if (view.points.length === 1 && view.single) {
        active.jumpTo({ center: toLngLat(view.points[0]), zoom: glZoom(view.single.zoom) });
        return;
      }
      const bounds = paddedBounds(view.points, view.pad ?? 0.25);
      if (!bounds) return;
      active.fitBounds(bounds, {
        ...(view.maxZoom === undefined ? {} : { maxZoom: glZoom(view.maxZoom) }),
        ...(view.animate === false ? { animate: false } : {})
      });
    };
    // A map framed while its dialog is still opening measures 0×0.
    if (view.defer) {
      later(() => {
        active.resize();
        fit();
      }, 0);
      return;
    }
    fit();
  }

  // --- The credit ----------------------------------------------------------

  /**
   * On a narrow map MapLibre folds the credit into an (i) button — but opens it
   * expanded, and only folds it once the reader touches the map. On a lightbox
   * mini map that is a third of the picture covered by text. Folded from the
   * start instead, the same way its own button folds it, and one click away.
   * Wide maps are not compact and keep the full credit showing.
   */
  function collapseCredit(): void {
    const credit = container?.querySelector(".maplibregl-ctrl-attrib.maplibregl-compact-show");
    if (!credit) return;
    credit.setAttribute("open", "");
    credit.classList.remove("maplibregl-compact-show");
  }

  // --- Style & theme -----------------------------------------------------------

  function onStyleLoad(): void {
    styleReady = true;
    installCluster();
    drawLines();
  }

  async function followTheme(): Promise<void> {
    const nowDark = isDarkTheme();
    if (nowDark === dark || !map || !options) return;
    dark = nowDark;
    try {
      const style = await loadMapStyle(await loadMapConfig(options.share), dark);
      if (!map || destroyed) return;
      styleReady = false;
      // Replacing the style drops every layer and source this adapter added;
      // style.load puts the lines and the cluster back. HTML markers survive.
      map.setStyle(style as unknown as StyleSpecification, { diff: false });
    } catch (err) {
      console.warn("map: could not switch style for the theme", err);
    }
  }

  async function start(): Promise<void> {
    if (!container || !options) return;
    const host = container;
    const opts = options;
    let style: unknown;
    try {
      style = await loadMapStyle(await loadMapConfig(opts.share), dark);
    } catch (err) {
      if (destroyed) return;
      console.warn("map: style unavailable", err);
      showNotice(host, i18n.t("common:map.unavailable"));
      return;
    }
    if (destroyed) return;

    const created = new GlMap({
      container: host,
      style: style as StyleSpecification,
      center: toLngLat(opts.center),
      zoom: glZoom(opts.zoom),
      ...(opts.minZoom === undefined ? {} : { minZoom: glZoom(opts.minZoom) }),
      scrollZoom: opts.scrollWheelZoom ?? true,
      renderWorldCopies: true,
      attributionControl: false,
      // Flat, north-up maps, as they have always been here.
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false
    });
    created.touchZoomRotate.disableRotation();
    map = created;

    attribution = new AttributionControl({ customAttribution: [...credits] });
    created.addControl(attribution);
    created.once("idle", collapseCredit);

    created.on("click", (event) => {
      const target = event.originalEvent.target as Element | null;
      if (target?.closest?.(".maplibregl-marker")) return;
      const at = event.lngLat.wrap();
      handlers.onMapClick?.({ lat: at.lat, lng: at.lng });
    });
    created.on("error", (event) => console.warn("map:", event.error?.message ?? event));
    created.on("style.load", onStyleLoad);
    created.on("render", () => {
      if (options?.cluster) queueRefresh();
    });
    created.once("load", () => {
      loaded = true;
      if (pendingView) {
        const view = pendingView;
        pendingView = null;
        doView(view);
      }
    });

    drawHtml();
    themeObserver = new MutationObserver(() => void followTheme());
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    // The container is sized by CSS; settle any layout race so the map fills it.
    later(() => created.resize(), 0);
  }

  return {
    mount(host, opts, live) {
      container = host;
      options = opts;
      handlers = live;
      if (!webglAvailable()) {
        showNotice(host, i18n.t("common:map.unsupported"));
        return;
      }
      if (!workerReady) {
        setWorkerUrl(workerUrl);
        workerReady = true;
      }
      dark = isDarkTheme();
      void start();
    },

    setShapes(next) {
      shapes = next;
      if (!map) return;
      drawHtml();
      if (styleReady) {
        installCluster();
        drawLines();
      }
    },

    applyView(view) {
      if (!map || !loaded) {
        // Only the latest intention matters by the time the map can act on it.
        pendingView = view;
        return;
      }
      doView(view);
    },

    addAttribution(html) {
      if (credits.has(html)) return;
      credits.add(html);
      if (!map) return;
      // The control's credits are fixed when it is made, so a new one replaces it.
      if (attribution) map.removeControl(attribution);
      attribution = new AttributionControl({ customAttribution: [...credits] });
      map.addControl(attribution);
      map.once("idle", collapseCredit);
    },

    destroy() {
      destroyed = true;
      for (const id of timers) window.clearTimeout(id);
      timers.clear();
      themeObserver?.disconnect();
      themeObserver = null;
      for (const item of drawn) item.dispose();
      drawn = [];
      clearClusters();
      map?.remove();
      map = null;
      probe = null;
      credits.clear();
      handlers = {};
    }
  };
}
