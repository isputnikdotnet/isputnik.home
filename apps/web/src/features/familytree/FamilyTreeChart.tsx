import { useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  FileUp,
  House,
  Maximize,
  Minus,
  Network,
  Pencil,
  Plus,
  Settings,
  UserRound,
  UserRoundPlus,
  UsersRound
} from "lucide-react";
import { navigate } from "../../router";
import { Button } from "../../shared/Button";
import {
  computeChartLayout,
  isEndedUnion,
  NODE_H,
  NODE_W,
  type ChartLayout,
  type PlacedUnionDot
} from "./chart-layout";
import { lifeYears, type FamilyPerson, type FamilyTree, type FamilyUnion } from "./types";

const MIN_SCALE = 0.3;
const MAX_SCALE = 3;
// Hover text on the union badge — the icon says current or ended, this says why.
const UNION_BADGE_LABEL: Record<FamilyUnion["status"], string> = {
  married: "Married",
  partners: "Partners",
  divorced: "Divorced",
  widowed: "Widowed",
  unknown: "Partners (status not recorded)"
};
// Card menu popover size, used to keep it inside the chart frame.
const CARD_MENU_W = 208;
const CARD_MENU_H = 176;

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

// The marker between two spouse cards. A union still in place gets interlocked
// wedding rings — woven, so they read as linked and not as two loose circles;
// a divorce separates them and cuts the link with the genealogist's "//"; a
// union ended by death keeps the rings linked but drawn as an outline. All three
// are built from arcs rather than an icon font so they survive any zoom.
function UnionBadge({ dot }: { dot: PlacedUnionDot }) {
  const { x, y, status } = dot;
  const ended = isEndedUnion(status);
  const parted = status === "divorced";
  const offset = parted ? 4.5 : 2.8;
  const ringR = parted ? 3.7 : 4.3;
  // Where the right ring crosses the left one, top side: the arc redrawn there
  // (over a wider "cut" in the badge colour) is what makes the weave.
  const weaveFrom = { x: x + offset - 3.606, y: y - 2.342 };
  const weaveTo = { x: x + offset - 1.749, y: y - 3.928 };
  const weave = `M ${weaveFrom.x.toFixed(2)} ${weaveFrom.y.toFixed(2)} A ${ringR} ${ringR} 0 0 1 ${weaveTo.x.toFixed(2)} ${weaveTo.y.toFixed(2)}`;

  return (
    <g className={`ft-chart-union-badge is-${status}${ended ? " is-ended" : ""}`}>
      <title>{UNION_BADGE_LABEL[status]}</title>
      <circle className="ft-chart-union-plate" cx={x} cy={y} r={12} />
      <circle className="ft-chart-union-ring" cx={x + offset} cy={y} r={ringR} />
      <circle className="ft-chart-union-ring" cx={x - offset} cy={y} r={ringR} />
      {!parted && (
        <>
          <path className="ft-chart-union-weave-cut" d={weave} />
          <path className="ft-chart-union-weave" d={weave} />
        </>
      )}
      {parted && (
        <>
          <path className="ft-chart-union-break" d={`M ${x - 1.7} ${y + 4.4} L ${x - 0.5} ${y - 4.4}`} />
          <path className="ft-chart-union-break" d={`M ${x + 0.5} ${y + 4.4} L ${x + 1.7} ${y - 4.4}`} />
        </>
      )}
    </g>
  );
}

function personTone(person: FamilyPerson) {
  return person.gender === "male" || person.gender === "female" || person.gender === "other"
    ? person.gender
    : "unknown";
}

function shortText(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// "Anna Maria Posse" → ["Anna Maria", "Posse"]; single-word names get one line.
function splitName(name: string): [string, string | null] {
  const parts = name.trim().split(/\s+/);
  if (parts.length <= 1) return [parts[0] ?? "", null];
  return [parts.slice(0, -1).join(" "), parts[parts.length - 1]];
}

// Filled placeholder silhouettes for cards without a portrait — a bust for
// men, a bust with a bun for women (24×24 coordinate space, scaled by caller).
function SilhouetteShape({ tone }: { tone: string }) {
  return (
    <>
      {tone === "female" ? (
        <>
          <circle cx={11.6} cy={8.4} r={4.1} />
          <circle cx={15.7} cy={4.6} r={2.1} />
          <path d="M11.8 13.8c-4.8 0-7.6 2.6-8 6.3-.06.5.34.9.85.9h14.3c.5 0 .9-.4.85-.9-.4-3.7-3.2-6.3-8-6.3z" />
        </>
      ) : (
        <>
          <circle cx={12} cy={7.8} r={4.3} />
          <path d="M12 13.4c-5 0-7.9 2.7-8.3 6.6-.06.5.34.9.85.9h14.9c.5 0 .9-.4.85-.9-.4-3.9-3.3-6.6-8.3-6.6z" />
        </>
      )}
    </>
  );
}

// The pan/zoom SVG chart, laid out top-to-bottom by generation (see
// chart-layout.ts). This component renders it and owns the viewport: drag to
// pan, wheel/pinch to zoom, buttons for zoom/fit. Clicking a card re-centers
// the tree on that person; a single "⋯" badge per card opens the card menu
// (profile, and — for anyone who may edit that person — edit and add-relative),
// so the cards stay readable instead of carrying a stack of icons.
export function FamilyTreeChart({
  tree,
  focusId,
  onFocus,
  onOpenProfile,
  onEditPerson,
  onAddRelative,
  onHome,
  onAddPerson,
  onImport,
  onExport,
  onSettings
}: {
  tree: FamilyTree;
  focusId: string;
  onFocus: (personId: string) => void;
  onOpenProfile: (personId: string) => void;
  onEditPerson: (person: FamilyPerson) => void;
  onAddRelative: (person: FamilyPerson) => void;
  /** Back to the tree's starting person (the chart re-fits on top of it). */
  onHome: () => void;
  // The rail's manage group; each is omitted when the viewer may not do it.
  onAddPerson?: () => void;
  onImport?: () => void;
  onExport?: () => void;
  onSettings?: () => void;
}) {
  const layout: ChartLayout = useMemo(() => computeChartLayout(tree, focusId), [tree, focusId]);
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<ViewBox | null>(null);
  const [cardMenuId, setCardMenuId] = useState<string | null>(null);
  // Live pointer state for pan + pinch; refs so move events don't re-render.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gestureStart = useRef<{ view: ViewBox; dist: number | null } | null>(null);
  const movedRef = useRef(false);
  // Which card menu was open when the gesture started, so tapping the same
  // badge twice toggles instead of closing-then-reopening.
  const cardMenuAtPointerDown = useRef<string | null>(null);

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

  // Re-fit when the focus changes (the layout is rebuilt around a new origin);
  // a card menu anchored to the old layout goes with it.
  useEffect(() => { fit(); setCardMenuId(null); }, [layout]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!cardMenuId) return;
    // The chart's own pointer handler already decided the badge case; this
    // covers clicks that land outside the chart entirely.
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest?.(".ft-chart-card-menu")) setCardMenuId(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCardMenuId(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [cardMenuId]);

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
    setCardMenuId(null);
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
    // Any touch on the canvas dismisses an open card menu; the badge's own
    // click then re-opens it (or closes it, if it was that card's menu).
    cardMenuAtPointerDown.current = cardMenuId;
    setCardMenuId(null);
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

  // The open card's menu is HTML floating over the SVG, so its badge position
  // has to be mapped from user space to pixels — recomputed every render, which
  // is how it stays glued to the card while the chart pans and zooms.
  const cardMenuNode = cardMenuId ? layout.nodes.find((node) => node.person.id === cardMenuId) ?? null : null;
  const cardMenuPos = (() => {
    const svg = svgRef.current;
    if (!cardMenuNode || !svg) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    // Mirrors the default "xMidYMid meet" fit of the viewBox.
    const scale = Math.min(rect.width / box.w, rect.height / box.h);
    const badgeX = cardMenuNode.x + NODE_W / 2 - 15;
    const badgeY = cardMenuNode.y - NODE_H / 2 + 15;
    const left = (rect.width - box.w * scale) / 2 + (badgeX - box.x) * scale;
    const top = (rect.height - box.h * scale) / 2 + (badgeY - box.y) * scale;
    return {
      left: Math.max(8, Math.min(left + 14, rect.width - CARD_MENU_W - 8)),
      top: Math.max(8, Math.min(top + 14, rect.height - CARD_MENU_H - 8))
    };
  })();

  const goHome = () => { onHome(); fit(); };

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
          {layout.edgePaths.map((edge, i) => (
            <path key={i} className={edge.ended ? "is-ended" : undefined} d={edge.d} />
          ))}
        </g>
        {/* Union badges between spouse cards — so someone with a former and a
            current partner doesn't read as married twice. */}
        <g>
          {layout.dots.map((dot) => (
            <UnionBadge key={dot.unionId} dot={dot} />
          ))}
        </g>
        <g>
          {layout.nodes.map(({ person, x, y, isFocus }, index) => {
            const years = lifeYears(person);
            // Compact vertical card: square portrait block on top, first and
            // last name on separate lines, years last.
            const top = y - NODE_H / 2;
            const left = x - NODE_W / 2;
            const photoInset = 7;
            const photoSize = NODE_W - photoInset * 2;
            const photoTop = top + photoInset;
            const tone = personTone(person);
            const [firstName, lastName] = splitName(person.name);
            const silScale = 3;
            return (
              <g
                key={person.id}
                className={`ft-chart-node is-${tone}${isFocus ? " is-focus" : ""}${cardMenuId === person.id ? " is-menu-open" : ""}`}
                onClick={() => { if (!movedRef.current) onFocus(person.id); }}
              >
                {/* Compact cards truncate long names — expose the full one on hover. */}
                <title>{years ? `${person.name} (${years})` : person.name}</title>
                <rect
                  className="ft-chart-card"
                  x={left}
                  y={top}
                  width={NODE_W}
                  height={NODE_H}
                  rx={10}
                />
                <clipPath id={`ft-clip-${index}`}>
                  <rect x={left + photoInset} y={photoTop} width={photoSize} height={photoSize} rx={6} />
                </clipPath>
                <rect
                  className="ft-chart-portrait-bg"
                  x={left + photoInset}
                  y={photoTop}
                  width={photoSize}
                  height={photoSize}
                  rx={6}
                />
                {person.portraitUrl ? (
                  <image
                    href={person.portraitUrl}
                    x={left + photoInset}
                    y={photoTop}
                    width={photoSize}
                    height={photoSize}
                    clipPath={`url(#ft-clip-${index})`}
                    preserveAspectRatio="xMidYMid slice"
                  />
                ) : (
                  // No clip on this group: a userSpaceOnUse clip rect would be
                  // dragged along by the transform; the shape fits the photo
                  // square by construction.
                  <g
                    className="ft-chart-silhouette"
                    transform={`translate(${x - 12 * silScale} ${photoTop + photoSize - 21.5 * silScale}) scale(${silScale})`}
                  >
                    <SilhouetteShape tone={tone} />
                  </g>
                )}
                <text className="ft-chart-name" x={x} y={top + (lastName ? 113 : 120)} textAnchor="middle">
                  {shortText(firstName, 14)}
                </text>
                {lastName && (
                  <text className="ft-chart-name" x={x} y={top + 127} textAnchor="middle">
                    {shortText(lastName, 14)}
                  </text>
                )}
                {years && (
                  <text className="ft-chart-years" x={x} y={top + 141} textAnchor="middle">
                    {years}
                  </text>
                )}
                {/* One badge per card: everything else lives in its menu. */}
                <ActionBadge
                  cx={left + NODE_W - 15}
                  cy={top + 15}
                  label={`Actions for ${person.name}`}
                  onActivate={() => {
                    if (movedRef.current) return;
                    setCardMenuId(cardMenuAtPointerDown.current === person.id ? null : person.id);
                  }}
                  className="ft-chart-menu-action"
                  radius={11}
                  iconSize={14}
                >
                  <g className="ft-chart-dots">
                    <circle cx={5} cy={12} r={2.1} />
                    <circle cx={12} cy={12} r={2.1} />
                    <circle cx={19} cy={12} r={2.1} />
                  </g>
                </ActionBadge>
              </g>
            );
          })}
        </g>
      </svg>

      {cardMenuNode && cardMenuPos && (
        <div
          className="ft-chart-card-menu"
          style={{ left: cardMenuPos.left, top: cardMenuPos.top, width: CARD_MENU_W }}
          role="menu"
          aria-label={`Actions for ${cardMenuNode.person.name}`}
        >
          <p className="ft-chart-card-menu-name">{cardMenuNode.person.name}</p>
          <Button
            variant="text"
            className="select-menu-option action-menu-option"
            role="menuitem"
            onClick={() => { setCardMenuId(null); onOpenProfile(cardMenuNode.person.id); }}
          >
            <span className="select-menu-option-icon" aria-hidden="true"><UserRound size={16} /></span>
            <span>Open profile</span>
          </Button>
          {cardMenuNode.person.canEdit && (
            <Button
              variant="text"
              className="select-menu-option action-menu-option"
              role="menuitem"
              onClick={() => { setCardMenuId(null); onEditPerson(cardMenuNode.person); }}
            >
              <span className="select-menu-option-icon" aria-hidden="true"><Pencil size={16} /></span>
              <span>Edit person</span>
            </Button>
          )}
          {cardMenuNode.person.canEdit && (
            <Button
              variant="text"
              className="select-menu-option action-menu-option"
              role="menuitem"
              onClick={() => { setCardMenuId(null); onAddRelative(cardMenuNode.person); }}
            >
              <span className="select-menu-option-icon" aria-hidden="true"><UserRoundPlus size={16} /></span>
              <span>Add a relative</span>
            </Button>
          )}
        </div>
      )}

      {/* Standing rail, top-left of the frame: the call to action, then the ways
          out of the current view. Kept out of the page header so the chart owns
          its own chrome. */}
      <nav className="ft-chart-rail" aria-label="Tree navigation">
        {onAddPerson && (
          <>
            <Button
              variant="text"
              className="ft-chart-rail-button is-accent"
              title="Add a family member"
              onClick={onAddPerson}
            >
              <UserRoundPlus size={19} aria-hidden="true" />
              <span>Add person</span>
            </Button>
            <span className="ft-chart-rail-divider" />
          </>
        )}

        <Button variant="text" className="ft-chart-rail-button" title="Back to the starting person" onClick={goHome}>
          <House size={19} aria-hidden="true" />
          <span>Home</span>
        </Button>
        <Button
          variant="text"
          className="ft-chart-rail-button"
          title="Every family member"
          onClick={() => navigate("/family/people")}
        >
          <UsersRound size={19} aria-hidden="true" />
          <span>All People</span>
        </Button>
        <Button
          variant="text"
          className="ft-chart-rail-button"
          title="Pick a family name to focus on"
          onClick={() => navigate("/family/families")}
        >
          <Network size={19} aria-hidden="true" />
          <span>Families</span>
        </Button>

        {(onImport || onExport || onSettings) && <span className="ft-chart-rail-divider" />}

        {onImport && (
          <Button variant="text" className="ft-chart-rail-button" title="Import a GEDCOM file" onClick={onImport}>
            <FileUp size={19} aria-hidden="true" />
            <span>Import</span>
          </Button>
        )}
        {onExport && (
          <Button
            variant="text"
            className="ft-chart-rail-button"
            title="Export the whole tree as GEDCOM (.ged)"
            onClick={onExport}
          >
            <Download size={19} aria-hidden="true" />
            <span>Export</span>
          </Button>
        )}
        {onSettings && (
          <Button variant="text" className="ft-chart-rail-button" title="Family tree settings" onClick={onSettings}>
            <Settings size={19} aria-hidden="true" />
            <span>Settings</span>
          </Button>
        )}
      </nav>

      <aside className="ft-chart-legend" aria-label="Chart legend">
        <strong className="ft-chart-legend-title">Legend</strong>
        <ul className="ft-chart-legend-list">
          <li>
            <span className="ft-legend-mark" aria-hidden="true">
              <svg viewBox="0 0 22 22" role="presentation">
                <path className="ft-legend-edge" d="M4 5h7v12h7" />
              </svg>
            </span>
            Parent / Child
          </li>
          <li>
            <span className="ft-legend-mark" aria-hidden="true">
              <svg viewBox="0 0 22 22" role="presentation">
                <circle className="ft-legend-union-ring" cx={13.8} cy={11} r={4.3} />
                <circle className="ft-legend-union-ring" cx={8.2} cy={11} r={4.3} />
                <path className="ft-legend-union-cut" d="M10.19 8.66 A 4.3 4.3 0 0 1 12.05 7.07" />
                <path className="ft-legend-union-ring" d="M10.19 8.66 A 4.3 4.3 0 0 1 12.05 7.07" />
              </svg>
            </span>
            Married / Partner
          </li>
          <li>
            <span className="ft-legend-mark" aria-hidden="true">
              <svg viewBox="0 0 22 22" role="presentation">
                <circle className="ft-legend-union-ring is-ended" cx={6.5} cy={11} r={3.7} />
                <circle className="ft-legend-union-ring is-ended" cx={15.5} cy={11} r={3.7} />
                <path className="ft-legend-union-ring is-ended" d="M9.3 15.4 L10.5 6.6" />
                <path className="ft-legend-union-ring is-ended" d="M11.5 15.4 L12.7 6.6" />
              </svg>
            </span>
            Divorced / Ended
          </li>
          <li><span className="ft-legend-swatch is-male" aria-hidden="true" />Male</li>
          <li><span className="ft-legend-swatch is-female" aria-hidden="true" />Female</li>
          <li><span className="ft-legend-swatch is-unknown" aria-hidden="true" />Not recorded</li>
          <li><span className="ft-legend-swatch is-focus" aria-hidden="true" />Focused person</li>
        </ul>
      </aside>

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
