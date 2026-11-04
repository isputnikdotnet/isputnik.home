import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { followRoute } from "../../router";
import { DEFAULT_COVERS, DEFAULT_WIDE_COVERS } from "../audiobooks/covers";

export interface PosterItem {
  key: string;
  href: string;
  title: string;
  /** The line under the name: a year, an episode, how many films. */
  sub?: string | null;
  poster?: string | null;
  /** Which placeholder art stands in while there is no poster. */
  kind: "movie" | "show";
  /** 0–1: how far this person got; left out when they haven't started. */
  fraction?: number;
  watched?: boolean;
}

/** A card's cut: a tall poster, a wide frame of the film (Continue watching), or
 *  a poster cropped nearly square (the overview's shows). */
export type PosterShape = "poster" | "wide" | "box";

// A poster and its name, the TV app's card: no frame, a ring when you point at it.
// A link, so it opens in a new tab like any address. With no picture yet, the
// card says what it is inside itself, over the kind's placeholder art.
export function PosterCard({ item, shape = "poster" }: { item: PosterItem; shape?: PosterShape }) {
  const { t } = useTranslation();
  const placeholder = shape === "wide" ? DEFAULT_WIDE_COVERS[item.kind] : DEFAULT_COVERS[item.kind];
  const watched = item.watched && <Check size={15} className="video-watched-mark" aria-label={t("video.watched")} />;
  return (
    <a className={`video-card is-${shape}`} href={item.href} onClick={(event) => followRoute(event, item.href)}>
      <span className={`video-card-cover${item.poster ? " has-poster" : " is-placeholder"}`}>
        <img src={item.poster ?? placeholder} alt="" loading="lazy" />
        {!item.poster && (
          <span className="video-card-blank">
            <strong>{item.title}</strong>
            {item.sub && <span>{item.sub}</span>}
          </span>
        )}
        {item.fraction !== undefined && item.fraction > 0 && item.fraction < 1 && (
          <span className="video-card-progress" aria-hidden="true"><span style={{ width: `${Math.round(item.fraction * 100)}%` }} /></span>
        )}
      </span>
      {/* A blank card already says its name; one with a picture says it underneath. */}
      {item.poster ? (
        <span className="video-card-body">
          <strong>{item.title}{watched}</strong>
          {item.sub && <span>{item.sub}</span>}
        </span>
      ) : watched}
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
export function PosterRow({ title, items, action, shape = "poster" }: { title: ReactNode; items: PosterItem[]; action?: ReactNode; shape?: PosterShape }) {
  if (items.length === 0) return null;
  return (
    <section className="video-row">
      <div className="video-row-head">
        <h2>{title}</h2>
        {action}
      </div>
      <ul className={`video-row-list is-${shape}`}>
        {items.map((item) => <li key={item.key}><PosterCard item={item} shape={shape} /></li>)}
      </ul>
    </section>
  );
}
