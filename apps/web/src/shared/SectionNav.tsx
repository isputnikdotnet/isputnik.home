import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { GripVertical, Home } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { followBack, followReplace, followRoute } from "../router";

// Every item is a link to a real address, with no escape hatch for one that
// isn't. Gallery's views were local state and were listed here behind an
// onClick that swallowed the click; a nav that looks like links but isn't
// breaks new-tab, middle-click and the browser's Back button, so the views
// became routes (GALLERY_VIEW_PATHS) instead of the nav learning to lie.
export interface SectionNavItem {
  key: string;
  label: string;
  href: string;
  /** Omitted inside a reorderable group, where the grip takes the same slot. */
  icon?: LucideIcon;
  /** Trailing tally ("Drafts 3") — omitted entirely when undefined. */
  count?: number;
}

export interface SectionNavGroup {
  label: string;
  items: SectionNavItem[];
  /** Present = the group's rows carry a grip and can be dragged into a new
   *  order, and this is called with the keys as they now read. The nav keeps no
   *  order of its own beyond the drag, so the list can't disagree with what was
   *  saved — the caller re-renders with the order the server accepted. */
  onReorder?: (orderedKeys: string[]) => void;
  /** A row under the group's items, inside the same frame ("Add chapter"). */
  footer?: ReactNode;
}

// The contextual left nav a media section (Gallery, Ebooks, Audiobooks, Family
// Tree, …) swaps in for the generic main nav — same shape as the control panel's
// and the user area's own sidebars: a way back to Home, then the section's own
// destinations. Settings/Profile/Logout live in DashboardShell's standard footer
// beneath every nav, so this only ever carries what's specific to the section.
//
// Most sections are one titled group (groupLabel + items); a section whose
// destinations fall into families (Stories: filters, kinds, shelves) passes
// `groups` instead and each family gets its own heading.
export function SectionNav({
  ariaLabel,
  groupLabel,
  items,
  groups,
  activeKey,
  exit,
  replace = false
}: {
  ariaLabel: string;
  groupLabel?: string;
  items?: SectionNavItem[];
  groups?: SectionNavGroup[];
  activeKey: string;
  /** Where this slot's way out leads instead, for a section you are inside
   *  rather than browsing. It is never a destination of the nav itself: the row
   *  means "leave", so it never reads as the active page, and every page the
   *  section owns is listed below it. Omitted keeps the link to Home.
   *
   *  `null` = no row at all, for a page that carries its own way out somewhere
   *  more visible — the story editor's strip of icons above the page. A nav
   *  whose first row went to the app's Home there would say the wrong thing,
   *  which is how this slot came to exist in the first place. */
  exit?: {
    label: string;
    href: string;
    icon?: LucideIcon;
    /** Leave the way they came in (Back), with `href` as the fallback for a
     *  visitor who arrived from outside the app. Without it the exit simply
     *  goes to `href`. */
    back?: boolean;
  } | null;
  /** The nav's own destinations are one page's internal views, so choosing one
   *  replaces the history entry rather than stacking another — the visit is a
   *  single step in the trail, which is what lets `exit.back` leave the page
   *  instead of stepping backwards through it. */
  replace?: boolean;
}) {
  const { t } = useTranslation();
  const rendered: SectionNavGroup[] = groups ?? [{ label: groupLabel ?? "", items: items ?? [] }];
  const ExitIcon = exit?.icon ?? Home;
  const exitHref = exit?.href ?? "/";
  return (
    <nav className="home-control-nav" aria-label={ariaLabel}>
      {exit !== null && (
        <a
          className="home-nav-link control-nav-exit"
          href={exitHref}
          onClick={(event) => (exit?.back ? followBack(event, exitHref) : followRoute(event, exitHref))}
        >
          <ExitIcon size={21} aria-hidden="true" />
          <span>{exit?.label ?? t("nav.home")}</span>
        </a>
      )}

      {rendered.map((group) => (
        (group.items.length > 0 || group.footer) && (
          <div className="home-control-group" key={group.label}>
            {group.label && <p>{group.label}</p>}
            {group.onReorder
              ? <ReorderableItems group={group} activeKey={activeKey} replace={replace} />
              : group.items.map((item) => (
                <SectionNavLink
                  key={item.key}
                  item={item}
                  active={item.key === activeKey}
                  replace={replace}
                />
              ))}
            {group.footer}
          </div>
        )
      ))}
    </nav>
  );
}

// A group whose rows can be dragged into a new order. The drag is live — rows
// shuffle under the pointer — and the new order is reported once, on drop.
function ReorderableItems({
  group,
  activeKey,
  replace
}: {
  group: SectionNavGroup;
  activeKey: string;
  replace: boolean;
}) {
  const keys = group.items.map((item) => item.key);
  const signature = keys.join(",");
  const [order, setOrder] = useState<string[]>(keys);
  const dragging = useRef<string | null>(null);
  // The same list the state holds, readable during an event: the drop handler
  // must report the order WITHOUT reading it from inside a state updater —
  // that runs during render, and calling the caller back from there is a
  // setState in someone else's render pass.
  const orderRef = useRef(order);

  // Adopt whatever the caller now lists: a saved reorder, an added row, a
  // deleted one. The dragged preview only lives until the drop is reported.
  useEffect(() => {
    orderRef.current = signature ? signature.split(",") : [];
    setOrder(orderRef.current);
  }, [signature]);

  const byKey = new Map(group.items.map((item) => [item.key, item]));

  const dragOver = (key: string) => {
    const from = dragging.current;
    if (!from || from === key) return;
    const next = [...orderRef.current];
    const fromIndex = next.indexOf(from);
    const toIndex = next.indexOf(key);
    if (fromIndex < 0 || toIndex < 0) return;
    next.splice(toIndex, 0, ...next.splice(fromIndex, 1));
    orderRef.current = next;
    setOrder(next);
  };

  const drop = () => {
    if (!dragging.current) return;
    dragging.current = null;
    if (orderRef.current.join(",") !== signature) group.onReorder?.(orderRef.current);
  };

  return (
    <>
      {order.map((key) => {
        const item = byKey.get(key);
        if (!item) return null;
        return (
          <SectionNavLink
            key={key}
            item={item}
            active={key === activeKey}
            replace={replace}
            grip={{
              onDragStart: () => { dragging.current = key; },
              onDragOver: () => dragOver(key),
              onDrop: drop,
              dragging: dragging.current === key
            }}
          />
        );
      })}
    </>
  );
}

function SectionNavLink({
  item,
  active,
  replace,
  grip
}: {
  item: SectionNavItem;
  active: boolean;
  replace: boolean;
  grip?: { onDragStart: () => void; onDragOver: () => void; onDrop: () => void; dragging: boolean };
}) {
  const Icon = item.icon;
  return (
    <a
      className={`home-nav-link${active ? " is-active" : ""}${grip ? " has-grip" : ""}`}
      href={item.href}
      aria-current={active ? "page" : undefined}
      onClick={(event) => (replace ? followReplace(event, item.href) : followRoute(event, item.href))}
      onDragOver={grip ? (event) => { event.preventDefault(); grip.onDragOver(); } : undefined}
      onDrop={grip ? (event) => { event.preventDefault(); grip.onDrop(); } : undefined}
    >
      {grip && (
        // Only the grip is draggable: a draggable row would fight the browser's
        // own link dragging, and a long title would leave nothing safe to aim at.
        <span
          className="section-nav-grip"
          draggable
          onDragStart={grip.onDragStart}
          onDragEnd={grip.onDrop}
          onClick={(event) => event.preventDefault()}
          aria-hidden="true"
        >
          <GripVertical size={15} />
        </span>
      )}
      {Icon && <Icon size={21} aria-hidden="true" />}
      <span>{item.label}</span>
      {item.count !== undefined && <span className="section-nav-count">{item.count}</span>}
    </a>
  );
}
