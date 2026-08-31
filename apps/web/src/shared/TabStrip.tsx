import type { LucideIcon } from "lucide-react";

// Two or three panels sharing one card, switched in place — for when the panels
// are peers a reader compares rather than pages they navigate between, and
// stacking them would mean scrolling past one to reach the other.
//
// Deliberately NOT another pill row. The control panel's tab row and the
// Dashboard's sub-tabs are both navigation, and a third row of pills inside a
// card would read as a third level of it; these render as headings, because
// that is what they replace — the <h3> of the panel you are looking at, with
// its siblings beside it greyed.
export interface TabStripItem<K extends string> {
  key: K;
  label: string;
  icon?: LucideIcon;
  /** Shown beside the label, for panels whose size is worth knowing before you open them. */
  count?: number;
}

export function TabStrip<K extends string>({
  items,
  active,
  onChange,
  ariaLabel
}: {
  items: TabStripItem<K>[];
  active: K;
  onChange: (key: K) => void;
  ariaLabel: string;
}) {
  return (
    <div className="tab-strip" role="tablist" aria-label={ariaLabel}>
      {items.map((item) => {
        const Icon = item.icon;
        const selected = item.key === active;
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={selected}
            className={selected ? "is-active" : undefined}
            onClick={() => onChange(item.key)}
          >
            {Icon && <Icon size={15} aria-hidden="true" />}
            {item.label}
            {item.count !== undefined && <span className="tab-strip-count">{item.count.toLocaleString()}</span>}
          </button>
        );
      })}
    </div>
  );
}
