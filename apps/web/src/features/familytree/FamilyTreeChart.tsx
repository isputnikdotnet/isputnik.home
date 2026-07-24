import { useEffect, useMemo, useRef, useState } from "react";
import { Maximize, Minus, Plus } from "lucide-react";
import { Button } from "../../shared/Button";
import { computeChartLayout, NODE_H, NODE_W, type ChartLayout } from "./chart-layout";
import { lifeYears, type FamilyTree } from "./types";

const MIN_SCALE = 0.3;
const MAX_SCALE = 3;

interface ViewBox { x: number; y: number; w: number; h: number }

// The pan/zoom SVG chart. All layout math lives in chart-layout.ts; this
// component renders it and owns the viewport: drag to pan, wheel/pinch to zoom,
// buttons for zoom/fit. Clicking a card re-centers the tree on that person.
export function FamilyTreeChart({
  tree,
  focusId,
  onFocus
}: {
  tree: FamilyTree;
  focusId: string;
  onFocus: (personId: string) => void;
}) {
  const layout: ChartLayout = useMemo(() => computeChartLayout(tree, focusId), [tree, focusId]);
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<ViewBox | null>(null);
  // Live pointer state for pan + pinch; refs so move events don't re-render.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gestureStart = useRef<{ view: ViewBox; dist: number | null } | null>(null);
  const movedRef = useRef(false);

  const fit = () => {
    const svg = svgRef.current;
    if (!svg || layout.nodes.length === 0) return;
    const { minX, minY, maxX, maxY } = layout.bounds;
    const rect = svg.getBoundingClientRect();
    const contentW = maxX - minX;
    const contentH = maxY - minY;
    // Fit the content, but never zoom a small tree past 1:1.
    const scale = Math.min(rect.width / contentW, rect.height / contentH, 1);
    const w = rect.width / scale;
    const h = rect.height / scale;
    setView({ x: minX + contentW / 2 - w / 2, y: minY + contentH / 2 - h / 2, w, h });
  };

  // Re-fit when the focus changes (the layout is rebuilt around a new origin).
  useEffect(() => { fit(); }, [layout]); // eslint-disable-line react-hooks/exhaustive-deps

  const zoomAt = (factor: number, clientX?: number, clientY?: number) => {
    const svg = svgRef.current;
    setView((current) => {
      if (!current || !svg) return current;
      const rect = svg.getBoundingClientRect();
      const scale = rect.width / current.w;
      const nextScale = Math.min(Math.max(scale * factor, MIN_SCALE), MAX_SCALE);
      const w = rect.width / nextScale;
      const h = rect.height / nextScale;
      // Keep the point under the cursor fixed while zooming.
      const fx = clientX != null ? (clientX - rect.left) / rect.width : 0.5;
      const fy = clientY != null ? (clientY - rect.top) / rect.height : 0.5;
      return {
        x: current.x + fx * current.w - fx * w,
        y: current.y + fy * current.h - fy * h,
        w,
        h
      };
    });
  };

  const onWheel = (event: React.WheelEvent) => {
    event.preventDefault();
    zoomAt(event.deltaY < 0 ? 1.15 : 1 / 1.15, event.clientX, event.clientY);
  };

  const pinchDistance = () => {
    const pts = [...pointers.current.values()];
    return pts.length >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : null;
  };

  const onPointerDown = (event: React.PointerEvent) => {
    (event.target as Element).setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (view) gestureStart.current = { view, dist: pinchDistance() };
    movedRef.current = false;
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (!pointers.current.has(event.pointerId)) return;
    const prev = pointers.current.get(event.pointerId)!;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();

    if (pointers.current.size >= 2) {
      // Pinch: scale the gesture's starting viewBox by the distance ratio.
      const start = gestureStart.current;
      const dist = pinchDistance();
      if (start?.dist && dist) {
        const rawScale = (rect.width / start.view.w) * (dist / start.dist);
        const scale = Math.min(Math.max(rawScale, MIN_SCALE), MAX_SCALE);
        const w = rect.width / scale;
        const h = rect.height / scale;
        setView({
          x: start.view.x + (start.view.w - w) / 2,
          y: start.view.y + (start.view.h - h) / 2,
          w,
          h
        });
      }
      movedRef.current = true;
      return;
    }

    const dx = event.clientX - prev.x;
    const dy = event.clientY - prev.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) movedRef.current = true;
    setView((current) =>
      current
        ? { ...current, x: current.x - dx * (current.w / rect.width), y: current.y - dy * (current.h / rect.height) }
        : current
    );
  };

  const onPointerUp = (event: React.PointerEvent) => {
    pointers.current.delete(event.pointerId);
    gestureStart.current = view ? { view, dist: pinchDistance() } : null;
  };

  if (layout.nodes.length === 0) return null;

  const box = view ?? {
    x: layout.bounds.minX,
    y: layout.bounds.minY,
    w: layout.bounds.maxX - layout.bounds.minX,
    h: layout.bounds.maxY - layout.bounds.minY
  };

  return (
    <div className="ft-chart-wrap">
      <svg
        ref={svgRef}
        className="ft-chart"
        viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
        role="img"
        aria-label="Family tree chart"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <g className="ft-chart-edges">
          {layout.edgePaths.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </g>
        <g>
          {layout.dots.map((dot) => (
            <circle key={dot.unionId} className="ft-chart-dot" cx={dot.x} cy={dot.y} r={5} />
          ))}
        </g>
        <g>
          {layout.nodes.map(({ person, x, y, isFocus }) => {
            const years = lifeYears(person);
            const initial = person.name.trim().charAt(0).toUpperCase();
            const portraitR = 15;
            const portraitCx = x - NODE_W / 2 + 23;
            return (
              <g
                key={person.id}
                className={`ft-chart-node${isFocus ? " is-focus" : ""}`}
                onClick={() => { if (!movedRef.current) onFocus(person.id); }}
              >
                {/* Compact cards truncate long names — expose the full one on hover. */}
                <title>{years ? `${person.name} (${years})` : person.name}</title>
                <rect
                  x={x - NODE_W / 2}
                  y={y - NODE_H / 2}
                  width={NODE_W}
                  height={NODE_H}
                  rx={10}
                />
                <clipPath id={`ft-clip-${person.id}`}>
                  <circle cx={portraitCx} cy={y} r={portraitR} />
                </clipPath>
                <circle className="ft-chart-portrait-bg" cx={portraitCx} cy={y} r={portraitR} />
                {person.portraitUrl ? (
                  <image
                    href={person.portraitUrl}
                    x={portraitCx - portraitR}
                    y={y - portraitR}
                    width={portraitR * 2}
                    height={portraitR * 2}
                    clipPath={`url(#ft-clip-${person.id})`}
                    preserveAspectRatio="xMidYMid slice"
                  />
                ) : (
                  <text className="ft-chart-initial" x={portraitCx} y={y + 5} textAnchor="middle">
                    {initial}
                  </text>
                )}
                <text className="ft-chart-name" x={portraitCx + portraitR + 8} y={years ? y - 1 : y + 4}>
                  {person.name.length > 12 ? `${person.name.slice(0, 11)}…` : person.name}
                </text>
                {years && (
                  <text className="ft-chart-years" x={portraitCx + portraitR + 8} y={y + 13}>
                    {years}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      <div className="ft-chart-controls">
        <Button variant="icon" aria-label="Zoom in" title="Zoom in" onClick={() => zoomAt(1.3)}>
          <Plus size={17} />
        </Button>
        <Button variant="icon" aria-label="Zoom out" title="Zoom out" onClick={() => zoomAt(1 / 1.3)}>
          <Minus size={17} />
        </Button>
        <Button variant="icon" aria-label="Fit tree to view" title="Fit to view" onClick={fit}>
          <Maximize size={17} />
        </Button>
      </div>
    </div>
  );
}
