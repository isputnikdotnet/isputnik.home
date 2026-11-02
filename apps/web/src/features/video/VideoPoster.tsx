import type { ReactNode } from "react";
import { Check } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { followRoute } from "../../router";

export interface PosterItem {
  key: string;
  href: string;
  title: string;
  /** The line under the name: a year, an episode, how many films. */
  sub?: string | null;
  poster?: string | null;
  /** For the corner of a cover with no picture. */
  icon: LucideIcon;
  /** 0–1: how far this person got; left out when they haven't started. */
  fraction?: number;
  watched?: boolean;
}

// A poster and its name, the TV app's card: no frame, a ring when you point at it.
// A link, so it opens in a new tab like any address.
export function PosterCard({ item }: { item: PosterItem }) {
  const { t } = useTranslation();
  const Icon = item.icon;
  return (
    <a className="video-card" href={item.href} onClick={(event) => followRoute(event, item.href)}>
      <span className={`video-card-cover${item.poster ? " has-poster" : ""}`} aria-hidden="true">
        {item.poster ? (
          <img src={item.poster} alt="" loading="lazy" />
        ) : (
          <>
            <Icon size={22} />
            <strong>{item.title.slice(0, 2).toUpperCase()}</strong>
          </>
        )}
        {item.fraction !== undefined && item.fraction > 0 && item.fraction < 1 && (
          <span className="video-card-progress"><span style={{ width: `${Math.round(item.fraction * 100)}%` }} /></span>
        )}
      </span>
      <span className="video-card-body">
        <strong>
          {item.title}
          {item.watched && <Check size={15} className="video-watched-mark" aria-label={t("video.watched")} />}
        </strong>
        {item.sub && <span>{item.sub}</span>}
      </span>
    </a>
  );
}

/** Every poster of a page, filling the width. */
export function PosterGrid({ items }: { items: PosterItem[] }) {
  return (
    <ul className="video-grid">
      {items.map((item) => <li key={item.key}><PosterCard item={item} /></li>)}
    </ul>
  );
}

/** One titled row, scrolled sideways inside itself, as on the TV. */
export function PosterRow({ title, items, action }: { title: ReactNode; items: PosterItem[]; action?: ReactNode }) {
  if (items.length === 0) return null;
  return (
    <section className="video-row">
      <div className="video-row-head">
        <h2>{title}</h2>
        {action}
      </div>
      <ul className="video-row-list">
        {items.map((item) => <li key={item.key}><PosterCard item={item} /></li>)}
      </ul>
    </section>
  );
}
