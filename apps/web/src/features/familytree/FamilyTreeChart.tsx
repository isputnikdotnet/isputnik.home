import { useEffect, useMemo, useRef, useState } from "react";
import { Maximize, Minus, Plus } from "lucide-react";
import { Button } from "../../shared/Button";
import { computeChartLayout, NODE_H, NODE_W, type ChartLayout } from "./chart-layout";
import { lifeYears, type FamilyPerson, type FamilyTree } from "./types";

const MIN_SCALE = 0.3;
const MAX_SCALE = 3;

interface ViewBox { x: number; y: number; w: number; h: number }

// A small circular action badge on a card's top edge. Icons are lucide paths
// (24×24 stroke drawings) scaled down — real lucide components can't render
// inside SVG geometry.
function ActionBadge({
  cx,
  cy,
  label,
  onActivate,
  children,
  className = "",
  radius = 11,
  iconSize = 12
}: {
  cx: number;
  cy: number;
  label: string;
  onActivate: () => void;
  children: React.ReactNode;
  className?: string;
  radius?: number;
  iconSize?: number;
}) {
  return (
    <g
      className={`ft-chart-action ${className}`.trim()}
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={(event) => { event.stopPropagation(); onActivate(); }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          onActivate();
        }
      }}
    >
      <title>{label}</title>
      <circle cx={cx} cy={cy} r={radius} />
      <g transform={`translate(${cx - iconSize / 2} ${cy - iconSize / 2}) scale(${iconSize / 24})`}>{children}</g>
    </g>
  );
}

function personTone(person: FamilyPerson) {
  return person.gender === "male" || person.gender === "female" || person.gender === "other"
    ? person.gender
    : "unknown";
}

function shortName(name: string) {
  return name.length > 18 ? `${name.slice(0, 17)}…` : name;
}

// The pan/zoom SVG chart, laid out left-to-right by generation (see
// chart-layout.ts). This component renders it and owns the viewport: drag to
// pan, wheel/pinch to zoom, buttons for zoom/fit. Clicking a card re-centers
// the tree on that person; the badges on each card open the profile or (for
// admins) the edit form directly.
export function FamilyTreeChart({
  tree,
  focusId,
  isAdmin,
  onFocus,
  onOpenProfile,
  onEditPerson
}: {
  tree: FamilyTree;
  focusId: string;
  isAdmin: boolean;
  onFocus: (personId: string) => void;
  onOpenProfile: (personId: string) => void;
  onEditPerson: (person: FamilyPerson) => void;
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
  const currentScale = (() => {
    const svg = svgRef.current;
    if (!svg || !view) return 100;
    const rect = svg.getBoundingClientRect();
    return rect.width > 0 ? Math.round((rect.width / view.w) * 100) : 100;
  })();

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
        {/* Union badges: the little "rings" marker between spouse cards. */}
        <g>
          {layout.dots.map((dot) => (
            <g key={dot.unionId} className="ft-chart-union-badge">
              <circle cx={dot.x} cy={dot.y} r={11} />
              <circle className="ft-chart-union-ring" cx={dot.x - 2.4} cy={dot.y} r={3.6} />
              <circle className="ft-chart-union-ring" cx={dot.x + 2.4} cy={dot.y} r={3.6} />
            </g>
          ))}
        </g>
        <g>
          {layout.nodes.map(({ person, x, y, isFocus }, index) => {
            const years = lifeYears(person);
            // Vertical card: portrait on top, name under it, dates last.
            const top = y - NODE_H / 2;
            const portraitR = 34;
            const portraitCy = top + 54;
            const tone = personTone(person);
            return (
              <g
                key={person.id}
                className={`ft-chart-node is-${tone}${isFocus ? " is-focus" : ""}`}
                onClick={() => { if (!movedRef.current) onFocus(person.id); }}
              >
                {/* Compact cards truncate long names — expose the full one on hover. */}
                <title>{years ? `${person.name} (${years})` : person.name}</title>
                <rect
                  x={x - NODE_W / 2}
                  y={top}
                  width={NODE_W}
                  height={NODE_H}
                  rx={8}
                />
                {isFocus && (
                  <g className="ft-chart-focus-badge">
                    <rect x={x - NODE_W / 2 + 12} y={top + 12} width={44} height={20} rx={10} />
                    <text x={x - NODE_W / 2 + 34} y={top + 26} textAnchor="middle">Focus</text>
                  </g>
                )}
                <clipPath id={`ft-clip-${index}`}>
                  <circle cx={x} cy={portraitCy} r={portraitR} />
                </clipPath>
                <circle className="ft-chart-portrait-bg" cx={x} cy={portraitCy} r={portraitR} />
                {person.portraitUrl ? (
                  <image
                    href={person.portraitUrl}
                    x={x - portraitR}
                    y={portraitCy - portraitR}
                    width={portraitR * 2}
                    height={portraitR * 2}
                    clipPath={`url(#ft-clip-${index})`}
                    preserveAspectRatio="xMidYMid slice"
                  />
                ) : (
                  <g className="ft-chart-silhouette" transform={`translate(${x - 19} ${portraitCy - 19}) scale(1.58)`}>
                    <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
                    <circle cx={12} cy={7} r={4} />
                  </g>
                )}
                <text className="ft-chart-name" x={x} y={top + 114} textAnchor="middle">
                  {shortName(person.name)}
                </text>
                {years && (
                  <text className="ft-chart-years" x={x} y={top + 132} textAnchor="middle">
                    {years}
                  </text>
                )}
                <ActionBadge
                  cx={x + NODE_W / 2 - 22}
                  cy={top + 22}
                  label={`Open ${person.name}'s profile`}
                  onActivate={() => { if (!movedRef.current) onOpenProfile(person.id); }}
                  className="ft-chart-person-action"
                  radius={13}
                  iconSize={14}
                >
                  <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
                  <circle cx={12} cy={7} r={4} />
                </ActionBadge>
                {isAdmin && (
                  <ActionBadge
                    cx={x + NODE_W / 2 - 52}
                    cy={top + 22}
                    label={`Edit ${person.name}`}
                    onActivate={() => { if (!movedRef.current) onEditPerson(person); }}
                    className="ft-chart-edit-action"
                    radius={11}
                    iconSize={12}
                  >
                    <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
                    <path d="m15 5 4 4" />
                  </ActionBadge>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      <div className="ft-chart-controls" aria-label="Tree view controls">
        <Button variant="icon" aria-label="Zoom out" title="Zoom out" onClick={() => zoomAt(1 / 1.3)}>
          <Minus size={17} />
        </Button>
        <span className="ft-chart-zoom-value" aria-label={`Current zoom ${currentScale}%`}>{currentScale}%</span>
        <Button variant="icon" aria-label="Zoom in" title="Zoom in" onClick={() => zoomAt(1.3)}>
          <Plus size={17} />
        </Button>
        <Button variant="icon" aria-label="Fit tree to view" title="Fit to view" onClick={fit}>
          <Maximize size={17} />
        </Button>
      </div>
    </div>
  );
}
