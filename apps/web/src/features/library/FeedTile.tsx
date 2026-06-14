import { BookOpen, Headphones, Play } from "lucide-react";
import { followRoute } from "../../router";
import { authorLine, feedHref, timeAgo, type FeedItem } from "./feed";

// Reuses the Audiobooks catalog card (.audiobook-catalog-*) so home / recent /
// continue tiles look identical to the main library. `progress` shows the
// in-progress pill + bar; `added` appends "· 3 days ago" to the author line.
export function FeedTile({ item, progress, added }: { item: FeedItem; progress?: boolean; added?: boolean }) {
  const href = feedHref(item);
  const percent = Math.round((item.percentComplete ?? 0) * 100);
  const meta = added
    ? [authorLine(item), timeAgo(item.discoveredAt)].filter(Boolean).join(" · ")
    : authorLine(item);

  return (
    <a className="audiobook-catalog-card grid home-feed-tile" href={href} onClick={(event) => followRoute(event, href)}>
      <div className="audiobook-catalog-cover">
        {item.coverUrl ? (
          <img src={item.coverUrl} alt="" loading="lazy" />
        ) : (
          <>
            <BookOpen size={34} aria-hidden="true" />
            <strong>{item.title.slice(0, 2).toUpperCase()}</strong>
          </>
        )}
        <span className={`home-tile-kind ${item.kind}`} title={item.kind === "ebook" ? "Ebook" : "Audiobook"}>
          {item.kind === "ebook" ? <BookOpen size={13} aria-hidden="true" /> : <Headphones size={13} aria-hidden="true" />}
        </span>
        {progress && percent > 0 && (
          <>
            <span className="audiobook-catalog-pct" title={`${percent}% complete`}>
              <Play size={9} fill="currentColor" aria-hidden="true" />{percent}%
            </span>
            <span className="audiobook-catalog-progress" aria-hidden="true">
              <span style={{ width: `${percent}%` }} />
            </span>
          </>
        )}
      </div>
      <div className="audiobook-catalog-copy">
        <strong>{item.title}</strong>
        <small>{meta}</small>
      </div>
    </a>
  );
}

export function FeedTileSkeleton() {
  return (
    <div className="audiobook-catalog-card grid home-feed-tile is-skeleton" aria-hidden="true">
      <div className="audiobook-catalog-cover" />
      <div className="home-skeleton-line" />
    </div>
  );
}
