import { useId, type ReactNode } from "react";

// A titled card of settings rows: an icon, a title and one line saying what the
// card is for, then its rows (a GroupedList without a title of its own) and an
// optional note under them. What an Overview page is made of — Libraries &
// content, Storage, Visibility & access… — two columns of these on a wide screen.

export function SettingsCard({ icon, title, description, note, children, className }: {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  /** A line under the rows, for what they all share ("These open … for Gallery only"). */
  note?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section className={["settings-card", className].filter(Boolean).join(" ")} aria-labelledby={id}>
      <header className="settings-card-head">
        <span className="settings-card-icon" aria-hidden="true">{icon}</span>
        <div>
          <h2 id={id}>{title}</h2>
          {description && <p>{description}</p>}
        </div>
      </header>
      {children}
      {note && <p className="settings-card-note">{note}</p>}
    </section>
  );
}
