import { useEffect, useState } from "react";
import { Clock, Headphones, type LucideIcon } from "lucide-react";
import type { PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { MessageBox } from "../../shared/MessageBox";
import { fetchFeed, type FeedItem, type FeedMode } from "./feed";
import { FeedTile, FeedTileSkeleton } from "./FeedTile";

// The page shows the most recent N — no pagination, just the latest slice.
const LIMIT = 50;

const MODES: Record<FeedMode, { title: string; emptyHeading: string; empty: string; icon: LucideIcon }> = {
  recent: {
    title: "Recently added",
    emptyHeading: "Nothing added yet",
    empty: "Newly added audiobooks and ebooks show up here.",
    icon: Clock
  },
  continue: {
    title: "Continue listening & reading",
    emptyHeading: "Nothing in progress",
    empty: "Open a book to start — it'll show up here so you can pick up where you left off.",
    icon: Headphones
  }
};

const count = (value: number) => new Intl.NumberFormat().format(value);

// Unified, cross-type feed page behind the home rows' "View all" links. `recent`
// lists newest additions across audiobooks + ebooks; `continue` lists in-progress.
// Capped at the latest LIMIT items.
export function LibraryFeedPage({ mode, user, logout }: { mode: FeedMode; user: PublicUser; logout: () => Promise<void> }) {
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [error, setError] = useState("");
  const meta = MODES[mode];

  useEffect(() => {
    let alive = true;
    setItems(null);
    setError("");
    fetchFeed(mode, LIMIT, 0)
      .then((res) => { if (alive) setItems(res.items); })
      .catch((err) => {
        if (!alive) return;
        setItems([]);
        setError(err instanceof Error ? err.message : "Unable to load this list");
      });
    return () => { alive = false; };
  }, [mode]);

  const EmptyIcon = meta.icon;

  return (
    <DashboardShell active="home" user={user} logout={logout}>
      {/* Same full-width wrapper the Audiobooks page uses, so the catalog grid
          fits the same number of columns (work-area caps width at 1040px). */}
      <section className="audiobook-main-page">
        <div className="section-head audiobook-head">
          <div>
            <p className="eyebrow">Digital library</p>
            <h1>{meta.title}</h1>
          </div>
          {items != null && items.length > 0 && (
            <span>{count(items.length)} {items.length === 1 ? "item" : "items"}</span>
          )}
        </div>

        {error && <MessageBox tone="error" title="Unable to load">{error}</MessageBox>}

        {items != null && items.length === 0 && !error ? (
          <div className="empty-state library-empty">
            <EmptyIcon size={58} aria-hidden="true" />
            <h2>{meta.emptyHeading}</h2>
            <p className="muted">{meta.empty}</p>
          </div>
        ) : (
          <div className="library-feed-grid">
            {items === null
              ? Array.from({ length: 12 }).map((_, index) => <FeedTileSkeleton key={index} />)
              : items.map((item) => (
                <FeedTile key={`${item.kind}-${item.id}`} item={item} progress={mode === "continue"} added={mode === "recent"} kindLabel />
              ))}
          </div>
        )}
      </section>
    </DashboardShell>
  );
}
