import { useEffect, useRef } from "react";
import { createRenderer } from "./renderer";
import { useMapShare } from "./share-context";
import type { MapHandlers, MapOptions, MapRenderer, MapShapes, MapViewCommand } from "./types";

// The one map component. Features say what to draw; this drives a `MapRenderer`
// and nothing else in the app touches a map library.
//
// Two rules it exists to keep in one place, both of which every hand-rolled map
// here had to solve for itself:
//
//  1. The map is built ONCE. Tearing it down on a prop change would throw away
//     wherever the reader had panned and zoomed to, so `options` seeds the first
//     view and is then left alone — later moves go through `view`.
//  2. Handlers outlive the render that made them. A marker's click fires long
//     after paint, so the callbacks are held in a ref refreshed after every
//     commit and the renderer is handed a stable object that reads through it.
//     Without that, a handler freezes on whichever callback the map happened to
//     be built with.

export interface MapViewProps extends MapHandlers {
  /** Seeds the first view and the map's fixed behaviour. Read once. */
  options: MapOptions;
  shapes: MapShapes;
  /** Applied whenever its IDENTITY changes, so callers decide with `useMemo`
   *  exactly when the map moves. `null` leaves the view where the reader put
   *  it — which is what a picker wants after its first frame. */
  view?: MapViewCommand | null;
  /** Credits earned by what was drawn (routing, say). Applied additively. */
  attributions?: string[];
  className?: string;
  ariaLabel?: string;
}

export function MapView({
  options,
  shapes,
  view = null,
  attributions,
  className,
  ariaLabel,
  ...handlers
}: MapViewProps) {
  const share = useMapShare();
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<MapRenderer | null>(null);

  // Refreshed after every commit rather than during render: the only readers
  // are map events, which cannot fire before paint.
  const handlersRef = useRef<MapHandlers>(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  // `options` is read once, so a caller that rebuilds the object every render
  // must not rebuild the map. The ref hands the create-once effect below the
  // current value without making the map depend on it.
  const optionsRef = useRef(options);
  optionsRef.current = share ? { ...options, share } : options;

  useEffect(() => {
    if (!containerRef.current || rendererRef.current) return;
    const renderer = createRenderer();
    renderer.mount(containerRef.current, optionsRef.current, {
      onMapClick: (point) => handlersRef.current.onMapClick?.(point),
      onMarkerClick: (id) => handlersRef.current.onMarkerClick?.(id),
      onMarkerDragEnd: (id, point) => handlersRef.current.onMarkerDragEnd?.(id, point),
      onCircleClick: (id) => handlersRef.current.onCircleClick?.(id)
    });
    rendererRef.current = renderer;
    return () => {
      renderer.destroy();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    rendererRef.current?.setShapes(shapes);
  }, [shapes]);

  useEffect(() => {
    if (view) rendererRef.current?.applyView(view);
  }, [view]);

  useEffect(() => {
    for (const credit of attributions ?? []) rendererRef.current?.addAttribution(credit);
  }, [attributions]);

  return <div className={className} ref={containerRef} aria-label={ariaLabel} />;
}
