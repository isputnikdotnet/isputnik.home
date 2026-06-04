import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, BookOpen, ChevronDown, Headphones, LayoutGrid, Library, List, Mic2, MoreVertical, Search, UserRound } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { FilterButton, FilterChips, SortSelect, type SortKey } from "./BookFilter";
import { useAudiobookCatalog, readCatalogView, writeCatalogView, type CatalogScope } from "./useAudiobookCatalog";
import { DashboardShell } from "../../app/DashboardShell";
import { CategoryIcon } from "./categoryIcons";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { formatDuration } from "../../shared/utils";
import type { AudiobookBook, AudiobookLibrary, LibrarySection } from "./types";


type AudiobookViewMode = "grid" | "list";

export function formatCount(value: number) {
  return new Intl.NumberFormat().format(value);
}

export function AudiobookTabs({ active }: { active: "books" | "authors" | "narrators" | "series" | "collections" | "categories" }) {
  const tabs = [
    { id: "authors", label: "Authors", href: "/audiobooks/authors", icon: UserRound },
    { id: "narrators", label: "Narrators", href: "/audiobooks/narrators", icon: Mic2 },
    { id: "series", label: "Series", href: "/audiobooks/series", icon: Library }
  ] as const;

  return (
    <nav className="audiobook-page-tabs" aria-label="Audiobook views">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        return (
          <a
            key={tab.id}
            className={active === tab.id ? "active" : ""}
            href={tab.href}
            onClick={(event) => {
              event.preventDefault();
              navigate(tab.href);
            }}
          >
            <Icon size={19} aria-hidden="true" />
            <span>{tab.label}</span>
          </a>
        );
      })}
    </nav>
  );
}

export function AudiobookPageHeader({
  title,
  subtitle,
  search,
  onSearchChange,
  searchPlaceholder
}: {
  title: string;
  subtitle?: string;
  search?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
}) {
  return (
    <header className="audiobook-page-header">
      <div className="audiobook-page-title">
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {onSearchChange && (
        <div className="audiobook-page-actions">
          <label className="audiobook-page-search">
            <span className="sr-only">{searchPlaceholder ?? "Search audiobooks"}</span>
            <Search size={22} aria-hidden="true" />
            <input
              type="search"
              value={search ?? ""}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder={searchPlaceholder ?? "Search audiobooks..."}
            />
          </label>
        </div>
      )}
    </header>
  );
}

function CatalogBookCard({ book, viewMode }: { book: AudiobookBook; viewMode: AudiobookViewMode }) {
  return (
    <article className={`audiobook-catalog-card ${viewMode}`}>
      <button className="audiobook-catalog-open" type="button" onClick={() => navigate(`/audiobooks/books/${book.id}`)}>
        <span className="audiobook-catalog-cover" aria-hidden="true">
          {book.coverUrl ? (
            <img src={book.coverUrl} alt="" />
          ) : (
            <>
              <BookOpen size={34} />
              <strong>{book.title.slice(0, 2).toUpperCase()}</strong>
            </>
          )}
          <span className="audiobook-catalog-badge">
            <Headphones size={17} />
          </span>
        </span>
        <span className="audiobook-catalog-copy">
          <strong>{book.title}</strong>
          <small>{book.authors.length > 0 ? book.authors.join(", ") : "Unknown author"}</small>
          {viewMode === "list" && (
            <span>
              {[book.narrators.length ? `Narrated by ${book.narrators.join(", ")}` : "", book.durationSeconds != null ? formatDuration(book.durationSeconds) : "", book.fileCount === 1 ? "1 file" : `${book.fileCount} files`]
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
        </span>
      </button>
      <button className="audiobook-catalog-menu" type="button" aria-label={`More options for ${book.title}`}>
        <MoreVertical size={18} aria-hidden="true" />
      </button>
    </article>
  );
}

// Bottom-of-grid loader: an IntersectionObserver sentinel for infinite scroll
// plus an explicit "Load more" button as a fallback.
function CatalogTail({
  hasMore, loadingMore, loadMore, sentinelRef
}: {
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  sentinelRef: RefObject<HTMLDivElement | null>;
}) {
  if (!hasMore) return null;
  return (
    <div className="audiobook-load-more" ref={sentinelRef}>
      <button className="secondary-button" type="button" onClick={loadMore} disabled={loadingMore}>
        {loadingMore ? "Loading…" : "Load more"}
      </button>
    </div>
  );
}

function ViewToggle({ viewMode, onChange }: { viewMode: AudiobookViewMode; onChange: (mode: AudiobookViewMode) => void }) {
  return (
    <div className="audiobook-view-toggle" role="group" aria-label="View mode">
      <button type="button" className={viewMode === "grid" ? "active" : ""} onClick={() => onChange("grid")} aria-label="Grid view">
        <LayoutGrid size={18} aria-hidden="true" />
      </button>
      <button type="button" className={viewMode === "list" ? "active" : ""} onClick={() => onChange("list")} aria-label="List view">
        <List size={18} aria-hidden="true" />
      </button>
    </div>
  );
}

export function AudiobooksPage({
  user,
  logout
}: {
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const [libraries, setLibraries] = useState<AudiobookLibrary[]>([]);
  const [sections, setSections] = useState<LibrarySection[]>([]);
  const [selectedLibraryId, setSelectedLibraryId] = useState(() => readCatalogView("audiobooks:main").selectedLibraryId);
  const [librariesError, setLibrariesError] = useState("");
  const [viewMode, setViewMode] = useState<AudiobookViewMode>("grid");
  const [libraryMenuOpen, setLibraryMenuOpen] = useState(false);
  const [libraryMenuPos, setLibraryMenuPos] = useState<{ top: number; left: number } | null>(null);
  const libraryTriggerRef = useRef<HTMLButtonElement>(null);
  const libraryMenuRef = useRef<HTMLDivElement>(null);

  const normalLibraries = libraries.filter((library) => !library.specialSection);
  const scope: CatalogScope = selectedLibraryId === "all" ? { kind: "all" } : { kind: "library", libraryId: selectedLibraryId };
  const cat = useAudiobookCatalog(scope, "recent", "audiobooks:main");

  useEffect(() => {
    writeCatalogView("audiobooks:main", { selectedLibraryId });
  }, [selectedLibraryId]);

  useEffect(() => {
    api<{ libraries: AudiobookLibrary[] }>("/api/library/audiobook-libraries")
      .then((payload) => setLibraries(payload.libraries))
      .catch((err) => setLibrariesError(err instanceof Error ? err.message : "Unable to load libraries"));
    api<{ sections: LibrarySection[] }>("/api/library/sections")
      .then((payload) => setSections(payload.sections))
      .catch(() => setSections([]));
  }, []);

  // While a library is scanning, refresh both the library status and the catalog
  // so new books appear without a manual reload.
  useEffect(() => {
    if (!libraries.some((library) => library.scanStatus === "scanning")) return;
    const timer = window.setInterval(() => {
      api<{ libraries: AudiobookLibrary[] }>("/api/library/audiobook-libraries")
        .then((payload) => setLibraries(payload.libraries))
        .catch(() => {});
      cat.refresh();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [libraries, cat.refresh]);

  const toggleLibraryMenu = () => {
    setLibraryMenuOpen((open) => {
      if (!open && libraryTriggerRef.current) {
        const rect = libraryTriggerRef.current.getBoundingClientRect();
        setLibraryMenuPos({ top: rect.bottom + 8, left: rect.left });
      }
      return !open;
    });
  };

  useEffect(() => {
    if (!libraryMenuOpen) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (libraryTriggerRef.current?.contains(target)) return;
      if (libraryMenuRef.current?.contains(target)) return;
      setLibraryMenuOpen(false);
    };
    const dismiss = () => setLibraryMenuOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [libraryMenuOpen]);

  const selectedLibraryLabel = selectedLibraryId === "all"
    ? "All Libraries"
    : normalLibraries.find((library) => library.id === selectedLibraryId)?.name ?? "All Libraries";
  const error = librariesError || cat.error;

  return (
    <DashboardShell active="audiobooks" user={user} logout={logout}>
      <section className="audiobook-main-page">
        <AudiobookPageHeader
          title="Audiobooks"
          subtitle={`${formatCount(cat.total)} audiobooks • ${formatCount(cat.facets.authors.length)} authors • ${formatCount(cat.facets.narrators.length)} narrators`}
          search={cat.search}
          onSearchChange={cat.setSearch}
          searchPlaceholder="Search audiobooks..."
        />

        {error && <MessageBox tone="error" title="Audiobooks error">{error}</MessageBox>}

        {normalLibraries.length === 0 ? (
          <div className="empty-state library-empty">
            <BookOpen size={58} aria-hidden="true" />
            {libraries.some((library) => library.specialSection) ? (
              <>
                <h2>No general audiobooks here</h2>
                <p className="muted">Open a special library shortcut to browse its books.</p>
              </>
            ) : (
              <>
                <h2>No audiobook libraries yet</h2>
                <p className="muted">An administrator can add libraries from the control panel.</p>
              </>
            )}
          </div>
        ) : (
          <>
            <div className="audiobook-page-nav-row">
              <div className="audiobook-page-tabs-with-library">
                <div className="audiobook-library-shortcuts">
                  <button
                    ref={libraryTriggerRef}
                    type="button"
                    className="audiobook-library-tab"
                    onClick={toggleLibraryMenu}
                    aria-haspopup="menu"
                    aria-expanded={libraryMenuOpen}
                    aria-label="Select library"
                  >
                    <BookOpen size={19} aria-hidden="true" />
                    <span>{selectedLibraryLabel}</span>
                    <ChevronDown size={16} aria-hidden="true" />
                  </button>
                  {libraryMenuOpen && libraryMenuPos && createPortal(
                    <div
                      ref={libraryMenuRef}
                      className="book-detail-action-menu audiobook-library-menu"
                      role="menu"
                      aria-label="Select library"
                      style={{ position: "fixed", top: libraryMenuPos.top, left: libraryMenuPos.left, right: "auto" }}
                    >
                      <button
                        type="button"
                        role="menuitem"
                        className={selectedLibraryId === "all" ? "active" : ""}
                        onClick={() => { setSelectedLibraryId("all"); setLibraryMenuOpen(false); }}
                      >
                        <span>All Libraries</span>
                      </button>
                      {normalLibraries.map((library) => (
                        <button
                          key={library.id}
                          type="button"
                          role="menuitem"
                          className={selectedLibraryId === library.id ? "active" : ""}
                          onClick={() => { setSelectedLibraryId(library.id); setLibraryMenuOpen(false); }}
                        >
                          <span>{library.name}</span>
                        </button>
                      ))}
                    </div>,
                    document.body
                  )}
                </div>
                <AudiobookTabs active="books" />
                {sections.length > 0 && (
                  <div className="audiobook-special-library-shortcuts">
                    {sections.map((section) => (
                      <button
                        className="audiobook-special-library-tab"
                        key={section.id}
                        type="button"
                        onClick={() => navigate(`/audiobooks/sections/${section.id}`)}
                        title={section.name}
                        aria-label={section.name}
                      >
                        <CategoryIcon icon={section.icon} size={20} />
                        <span>{section.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="audiobook-catalog-controls">
                <FilterButton facets={cat.facets} value={cat.filters} onChange={cat.setFilters} />
                <ViewToggle viewMode={viewMode} onChange={setViewMode} />
              </div>
            </div>

            <FilterChips value={cat.filters} onChange={cat.setFilters} />

            {libraries.some((library) => library.scanStatus === "scanning") && (
              <MessageBox tone="info" title="Scanning audiobooks">
                New metadata and covers will appear as the scan finishes.
              </MessageBox>
            )}

            <div className={`audiobook-catalog ${viewMode}`}>
              {cat.books.map((book) => (
                <CatalogBookCard key={book.id} book={book} viewMode={viewMode} />
              ))}
              {!cat.loading && cat.books.length === 0 && <p className="management-empty">No audiobooks match this filter.</p>}
            </div>

            <CatalogTail hasMore={cat.hasMore} loadingMore={cat.loadingMore} loadMore={cat.loadMore} sentinelRef={cat.sentinelRef} />
          </>
        )}
      </section>
    </DashboardShell>
  );
}

export function SectionPage({
  sectionId,
  user,
  logout
}: {
  sectionId: string;
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const [section, setSection] = useState<LibrarySection | null>(null);
  const [members, setMembers] = useState<AudiobookLibrary[]>([]);
  const [membersLoaded, setMembersLoaded] = useState(false);
  const viewKey = `audiobooks:section:${sectionId}`;
  const [sort, setSort] = useState<SortKey>(() => readCatalogView(viewKey).sort);
  const [viewMode, setViewMode] = useState<AudiobookViewMode>("grid");
  const [metaError, setMetaError] = useState("");
  const cat = useAudiobookCatalog({ kind: "section", sectionId }, sort, viewKey);

  useEffect(() => {
    writeCatalogView(viewKey, { sort });
  }, [viewKey, sort]);

  useEffect(() => {
    setMembersLoaded(false);
    Promise.all([
      api<{ sections: LibrarySection[] }>("/api/library/sections"),
      api<{ libraries: AudiobookLibrary[] }>("/api/library/audiobook-libraries")
    ])
      .then(([sectionsPayload, librariesPayload]) => {
        setSection(sectionsPayload.sections.find((s) => s.id === sectionId) ?? null);
        setMembers(librariesPayload.libraries.filter((library) => library.sectionId === sectionId));
        setMembersLoaded(true);
      })
      .catch((err) => setMetaError(err instanceof Error ? err.message : "Unable to load section"));
  }, [sectionId]);

  const error = metaError || cat.error;

  return (
    <DashboardShell active="audiobooks" user={user} logout={logout}>
      <section className="audiobook-main-page">
        <AudiobookPageHeader
          title={section?.name ?? "Section"}
          subtitle={`${formatCount(cat.total)} ${cat.total === 1 ? "book" : "books"}`}
          search={cat.search}
          onSearchChange={cat.setSearch}
          searchPlaceholder="Search title, author, or narrator"
        />

        {error && <MessageBox tone="error" title="Section error">{error}</MessageBox>}

        {membersLoaded && members.length === 0 ? (
          <div className="empty-state library-empty">
            <BookOpen size={58} aria-hidden="true" />
            <h2>No libraries in this section yet</h2>
            <p className="muted">An administrator can add libraries to it from the control panel.</p>
          </div>
        ) : (
          <>
            <div className="audiobook-page-nav-row">
              <div className="audiobook-page-tabs-with-library">
                <button className="audiobook-back-button" type="button" onClick={() => navigate("/audiobooks")}>
                  <ArrowLeft size={18} aria-hidden="true" />
                  <span>All libraries</span>
                </button>
              </div>
              <div className="audiobook-catalog-controls">
                <FilterButton facets={cat.facets} value={cat.filters} onChange={cat.setFilters} />
                <SortSelect value={sort} onChange={setSort} />
                <ViewToggle viewMode={viewMode} onChange={setViewMode} />
              </div>
            </div>

            <FilterChips value={cat.filters} onChange={cat.setFilters} />

            {members.some((library) => library.scanStatus === "scanning") && (
              <MessageBox tone="info" title="Scanning">
                New metadata and covers will appear as the scan finishes.
              </MessageBox>
            )}

            <div className={`audiobook-catalog ${viewMode}`}>
              {cat.books.map((book) => (
                <CatalogBookCard key={book.id} book={book} viewMode={viewMode} />
              ))}
              {!cat.loading && cat.books.length === 0 && <p className="management-empty">No books match this filter.</p>}
            </div>

            <CatalogTail hasMore={cat.hasMore} loadingMore={cat.loadingMore} loadMore={cat.loadMore} sentinelRef={cat.sentinelRef} />
          </>
        )}
      </section>
    </DashboardShell>
  );
}
