import { useEffect, useState } from "react";
import { BookOpen, ChevronRight, Headphones, Heart, Play } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api, type PublicUser } from "../api";
import { DashboardShell } from "../app/DashboardShell";
import { followRoute } from "../router";
import { MessageBox } from "../shared/MessageBox";
import { fetchFeed, type FeedItem, type FeedMode } from "../features/library/feed";
import { FeedTile, FeedTileSkeleton } from "../features/library/FeedTile";

// Upper bound fetched per row. Each row renders one line of fixed-size tiles and
// clips whatever doesn't fit (no horizontal scroll, no wrap) — so we fetch enough
// to fill a wide screen and let CSS decide how many actually show.
const FETCH = 16;

type Tone = "violet" | "green" | "blue" | "rose";

interface LibraryCountRow {
  bookCount: number;
}

interface StatCard {
  label: string;
  value: number;
  tone: Tone;
  icon: LucideIcon;
  href: string;
}

const count = (value: number) => new Intl.NumberFormat().format(value);

function RowHeader({ id, title, href }: { id: string; title: string; href: string }) {
  return (
    <div className="home-section-title">
      <h2 id={id}>{title}</h2>
      <a href={href} onClick={(event) => followRoute(event, href)}>
        <span>View all</span>
        <ChevronRight size={18} aria-hidden="true" />
      </a>
    </div>
  );
}

function FeedRow({ id, title, href, mode, items, emptyText }: {
  id: string;
  title: string;
  href: string;
  mode: FeedMode;
  items: FeedItem[] | null;
  emptyText: string;
}) {
  return (
    <section className="home-section" aria-labelledby={id}>
      <RowHeader id={id} title={title} href={href} />
      {items !== null && items.length === 0 ? (
        <p className="home-row-empty">{emptyText}</p>
      ) : (
        <div className="home-tile-grid">
          {items === null
            ? Array.from({ length: 10 }).map((_, index) => <FeedTileSkeleton key={index} />)
            : items.map((item) => (
              <FeedTile key={`${item.kind}-${item.id}`} item={item} progress={mode === "continue"} added={mode === "recent"} />
            ))}
        </div>
      )}
    </section>
  );
}

function StatTile({ card }: { card: StatCard }) {
  const Icon = card.icon;
  return (
    <a className="home-overview-card" href={card.href} onClick={(event) => followRoute(event, card.href)}>
      <span className={`home-overview-icon ${card.tone}`} aria-hidden="true">
        <Icon size={22} />
      </span>
      <span>
        <strong>{count(card.value)}</strong>
        <small>{card.label}</small>
      </span>
    </a>
  );
}

export function HomePage({ user, logout }: { user: PublicUser; logout: () => Promise<void> }) {
  const [continueItems, setContinueItems] = useState<FeedItem[] | null>(null);
  const [recentItems, setRecentItems] = useState<FeedItem[] | null>(null);
  const [stats, setStats] = useState({ audiobooks: 0, ebooks: 0, inProgress: 0, favorites: 0 });
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;

    Promise.allSettled([
      fetchFeed("continue", FETCH),
      fetchFeed("recent", FETCH),
      api<{ libraries: LibraryCountRow[] }>("/api/library/audiobook-libraries"),
      api<{ libraries: LibraryCountRow[] }>("/api/library/ebook-libraries"),
      api<{ books: unknown[] }>("/api/library/saved")
    ]).then(([cont, recent, audioLibs, ebookLibs, saved]) => {
      if (!alive) return;

      if (cont.status === "fulfilled") {
        setContinueItems(cont.value.items);
        setStats((prev) => ({ ...prev, inProgress: cont.value.total }));
      } else {
        setContinueItems([]);
      }

      if (recent.status === "fulfilled") {
        setRecentItems(recent.value.items);
      } else {
        setRecentItems([]);
        setError(recent.reason instanceof Error ? recent.reason.message : "Unable to load your library");
      }

      const sumBooks = (libs: LibraryCountRow[]) => libs.reduce((total, library) => total + (library.bookCount ?? 0), 0);
      if (audioLibs.status === "fulfilled") setStats((prev) => ({ ...prev, audiobooks: sumBooks(audioLibs.value.libraries) }));
      if (ebookLibs.status === "fulfilled") setStats((prev) => ({ ...prev, ebooks: sumBooks(ebookLibs.value.libraries) }));
      if (saved.status === "fulfilled") setStats((prev) => ({ ...prev, favorites: saved.value.books.length }));
    });

    return () => { alive = false; };
  }, []);

  const statCards: StatCard[] = [
    { label: "Audiobooks", value: stats.audiobooks, tone: "violet", icon: Headphones, href: "/audiobooks" },
    { label: "Ebooks", value: stats.ebooks, tone: "green", icon: BookOpen, href: "/ebooks" },
    { label: "In progress", value: stats.inProgress, tone: "blue", icon: Play, href: "/continue" },
    { label: "Favorites", value: stats.favorites, tone: "rose", icon: Heart, href: "/audiobooks/saved" }
  ];

  return (
    <DashboardShell active="home" user={user} logout={logout}>
      <section className="home-page" aria-label="Home">
        <header className="home-header">
          <div className="home-heading">
            <h1>Welcome back, {user.displayName}</h1>
            <p>Here's what's happening in your library</p>
          </div>
        </header>

        {error && <MessageBox tone="error" title="Unable to load home">{error}</MessageBox>}

        <div className="home-stats" aria-label="Library overview">
          {statCards.map((card) => <StatTile card={card} key={card.label} />)}
        </div>

        <div className="home-content">
          <FeedRow
            id="home-continue-title"
            title="Continue listening & reading"
            href="/continue"
            mode="continue"
            items={continueItems}
            emptyText="Nothing in progress yet — open a book to start."
          />
          <FeedRow
            id="home-recent-title"
            title="Recently added"
            href="/recent"
            mode="recent"
            items={recentItems}
            emptyText="No books yet. Newly added audiobooks and ebooks show up here."
          />
        </div>
      </section>
    </DashboardShell>
  );
}
