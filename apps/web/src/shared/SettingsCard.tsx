import { useId, type ReactNode } from "react";

// A titled card of settings rows: an icon, a title and one line saying what the
// card is for, then its rows (a GroupedList without a title of its own) and an
// optional note under them. What an Overview page is made of — Libraries &
// content, Storage, Visibility & access… — two columns of these on a wide screen —
// and a Settings tab, in a `settings-card-grid`.

export function SettingsCard({ id: anchor, icon, title, description, actions, note, children, className }: {
  /** The card's anchor, for the control panel's search to scroll to. */
  id?: string;
  icon: ReactNode;
  /** Usually words; may carry a badge or an ⓘ after them (Storage's System data). */
  title: ReactNode;
  description?: ReactNode;
  /** The card's own action, at the right of its head ("Create genre"). */
  actions?: ReactNode;
  /** A line under the rows, for what they all share ("These open … for Gallery only"). */
  note?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section id={anchor} className={["settings-card", className].filter(Boolean).join(" ")} aria-labelledby={id}>
      <header className="settings-card-head">
        <span className="settings-card-icon" aria-hidden="true">{icon}</span>
        <div>
          <h2 id={id}>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {actions && <div className="settings-card-head-actions">{actions}</div>}
      </header>
      {children}
      {note && <p className="settings-card-note">{note}</p>}
    </section>
  );
}
