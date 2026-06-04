import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, BookOpen, ChevronDown, Headphones, LayoutGrid, Library, List, Mic2, MoreVertical, Search, UserRound } from "lucide-react";
import { api, type PublicUser } from "../../api";
import {
  EMPTY_FILTERS,
  FilterButton,
  FilterChips,
  SortSelect,
  filterBooks,
  sortBooks,
  type BookFilters,
  type SortKey
} from "./BookFilter";
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

function uniqueNameCount(books: AudiobookBook[], key: "authors" | "narrators") {
  return new Set(books.flatMap((book) => book[key])).size;
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

export function AudiobooksPage({
  user,
  logout
}: {
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const [libraries, setLibraries] = useState<AudiobookLibrary[]>([]);
  const [sections, setSections] = useState<LibrarySection[]>([]);
  const [booksByLibrary, setBooksByLibrary] = useState<Record<string, AudiobookBook[]>>({});
  const [selectedLibraryId, setSelectedLibraryId] = useState("all");
  const [filters, setFilters] = useState<BookFilters>(EMPTY_FILTERS);
  const sort: SortKey = "recent";
  const [bookSearch, setBookSearch] = useState("");
  const [error, setError] = useState("");
  const [viewMode, setViewMode] = useState<AudiobookViewMode>("grid");
  const [libraryMenuOpen, setLibraryMenuOpen] = useState(false);
  const [libraryMenuPos, setLibraryMenuPos] = useState<{ top: number; left: number } | null>(null);
  const libraryTriggerRef = useRef<HTMLButtonElement>(null);
  const libraryMenuRef = useRef<HTMLDivElement>(null);

  const loadLibraryBooks = useCallback(async (libraryId: string) => {
    const payload = await api<{ books: AudiobookBook[] }>(`/api/library/audiobook-libraries/${libraryId}/books`);
    setBooksByLibrary((current) => ({ ...current, [libraryId]: payload.books }));
  }, []);

  const loadMissingLibraryBooks = useCallback(async (libraryIds: string[]) => {
    await Promise.all(libraryIds.map((libraryId) => loadLibraryBooks(libraryId)));
  }, [loadLibraryBooks]);

  useEffect(() => {
    api<{ libraries: AudiobookLibrary[] }>("/api/library/audiobook-libraries")
      .then(async (payload) => {
        setLibraries(payload.libraries);
        setSelectedLibraryId("all");
        // Only the main grid's (non-section) libraries need their books loaded here;
        // section books are shown inside the section view.
        await loadMissingLibraryBooks(
          payload.libraries.filter((library) => !library.specialSection).map((library) => library.id)
        );
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load audiobooks"));
  }, [loadMissingLibraryBooks]);

  useEffect(() => {
    api<{ sections: LibrarySection[] }>("/api/library/sections")
      .then((payload) => setSections(payload.sections))
      .catch(() => setSections([]));
  }, []);

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

  useEffect(() => {
    if (!libraries.some((library) => library.scanStatus === "scanning")) {
      return;
    }

    const timer = window.setInterval(() => {
      api<{ libraries: AudiobookLibrary[] }>("/api/library/audiobook-libraries")
        .then(async (payload) => {
          setLibraries(payload.libraries);
          await loadMissingLibraryBooks(
            payload.libraries.filter((library) => !library.specialSection).map((library) => library.id)
          );
        })
        .catch((err) => setError(err instanceof Error ? err.message : "Unable to refresh audiobooks"));
    }, 3000);

    return () => window.clearInterval(timer);
  }, [libraries, loadMissingLibraryBooks]);

  // Special-section libraries are walled off from the main grid; they appear only
  // behind their section's master icon.
  const normalLibraries = libraries.filter((library) => !library.specialSection);
  const allBooks = normalLibraries.flatMap((library) =>
    (booksByLibrary[library.id] ?? []).map((book) => ({ ...book, libraryName: library.name }))
  );
  const searchTerm = bookSearch.trim().toLowerCase();
  const searched = allBooks.filter((book) => {
    if (selectedLibraryId !== "all" && book.libraryId !== selectedLibraryId) return false;
    if (searchTerm) {
      const haystack = [book.title, book.libraryName, ...book.authors, ...book.narrators];
      if (!haystack.some((v) => v?.toLowerCase().includes(searchTerm))) return false;
    }
    return true;
  });
  const visibleBooks = sortBooks(filterBooks(searched, filters), sort);
  const authorCount = uniqueNameCount(allBooks, "authors");
  const narratorCount = uniqueNameCount(allBooks, "narrators");
  const selectedLibraryLabel = selectedLibraryId === "all"
    ? "All Libraries"
    : normalLibraries.find((library) => library.id === selectedLibraryId)?.name ?? "All Libraries";

  return (
    <DashboardShell active="audiobooks" user={user} logout={logout}>
      <section className="audiobook-main-page">
          <AudiobookPageHeader
            title="Audiobooks"
            subtitle={`${formatCount(allBooks.length)} audiobooks • ${formatCount(authorCount)} authors • ${formatCount(narratorCount)} narrators`}
            search={bookSearch}
            onSearchChange={setBookSearch}
            searchPlaceholder="Search audiobooks..."
          />

          {error && <MessageBox tone="error" title="Audiobooks error">{error}</MessageBox>}

          {normalLibraries.length === 0 && (
            <div className="empty-state library-empty">
              <BookOpen size={58} aria-hidden="true" />
              {libraries.some((library) => library.specialSection) ? (
                <>
                  <h2>No general audiobooks here</h2>
                  <p className="muted">Open a special library shortcut above to browse its books.</p>
                </>
              ) : (
                <>
                  <h2>No audiobook libraries yet</h2>
                  <p className="muted">An administrator can add libraries from the control panel.</p>
                </>
              )}
            </div>
          )}

          {normalLibraries.length > 0 && (
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
                  <FilterButton books={allBooks} value={filters} onChange={setFilters} />
                  <div className="audiobook-view-toggle" role="group" aria-label="View mode">
                    <button
                      type="button"
                      className={viewMode === "grid" ? "active" : ""}
                      onClick={() => setViewMode("grid")}
                      aria-label="Grid view"
                    >
                      <LayoutGrid size={18} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className={viewMode === "list" ? "active" : ""}
                      onClick={() => setViewMode("list")}
                      aria-label="List view"
                    >
                      <List size={18} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </div>

              <FilterChips value={filters} onChange={setFilters} />

              {libraries.some((library) => library.scanStatus === "scanning") && (
                <MessageBox tone="info" title="Scanning audiobooks">
                  New metadata and covers will appear as the scan finishes.
                </MessageBox>
              )}

              <div className={`audiobook-catalog ${viewMode}`}>
                {visibleBooks.map((book) => (
                  <CatalogBookCard key={book.id} book={book} viewMode={viewMode} />
                ))}
                {visibleBooks.length === 0 && <p className="management-empty">No audiobooks match this filter.</p>}
              </div>
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
  const [booksByLibrary, setBooksByLibrary] = useState<Record<string, AudiobookBook[]>>({});
  const [filters, setFilters] = useState<BookFilters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<SortKey>("title");
  const [bookSearch, setBookSearch] = useState("");
  const [viewMode, setViewMode] = useState<AudiobookViewMode>("grid");
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      api<{ sections: LibrarySection[] }>("/api/library/sections"),
      api<{ libraries: AudiobookLibrary[] }>("/api/library/audiobook-libraries")
    ])
      .then(async ([sectionsPayload, librariesPayload]) => {
        const found = sectionsPayload.sections.find((s) => s.id === sectionId) ?? null;
        setSection(found);
        const sectionMembers = librariesPayload.libraries.filter((library) => library.sectionId === sectionId);
        setMembers(sectionMembers);
        const booksLists = await Promise.all(
          sectionMembers.map((library) =>
            api<{ books: AudiobookBook[] }>(`/api/library/audiobook-libraries/${library.id}/books`)
              .then((payload) => [library.id, payload.books] as const)
          )
        );
        setBooksByLibrary(Object.fromEntries(booksLists));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load section"));
  }, [sectionId]);

  const allBooks = members.flatMap((library) =>
    (booksByLibrary[library.id] ?? []).map((book) => ({ ...book, libraryName: library.name }))
  );
  const searchTerm = bookSearch.trim().toLowerCase();
  const searched = allBooks.filter((book) => {
    if (searchTerm) {
      const haystack = [book.title, book.libraryName, ...book.authors, ...book.narrators];
      if (!haystack.some((v) => v?.toLowerCase().includes(searchTerm))) return false;
    }
    return true;
  });
  const visibleBooks = sortBooks(filterBooks(searched, filters), sort);

  return (
    <DashboardShell active="audiobooks" user={user} logout={logout}>
      <section className="audiobook-main-page">
        <AudiobookPageHeader
          title={section?.name ?? "Section"}
          subtitle={`${formatCount(allBooks.length)} ${allBooks.length === 1 ? "book" : "books"}`}
          search={bookSearch}
          onSearchChange={setBookSearch}
          searchPlaceholder="Search title, author, or narrator"
        />

        {error && <MessageBox tone="error" title="Section error">{error}</MessageBox>}

        {members.length === 0 ? (
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
                <FilterButton books={allBooks} value={filters} onChange={setFilters} />
                <SortSelect value={sort} onChange={setSort} />
                <div className="audiobook-view-toggle" role="group" aria-label="View mode">
                  <button
                    type="button"
                    className={viewMode === "grid" ? "active" : ""}
                    onClick={() => setViewMode("grid")}
                    aria-label="Grid view"
                  >
                    <LayoutGrid size={18} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={viewMode === "list" ? "active" : ""}
                    onClick={() => setViewMode("list")}
                    aria-label="List view"
                  >
                    <List size={18} aria-hidden="true" />
                  </button>
                </div>
              </div>
            </div>

            <FilterChips value={filters} onChange={setFilters} />

            {members.some((library) => library.scanStatus === "scanning") && (
              <MessageBox tone="info" title="Scanning">
                New metadata and covers will appear as the scan finishes.
              </MessageBox>
            )}

            <div className={`audiobook-catalog ${viewMode}`}>
              {visibleBooks.map((book) => (
                <CatalogBookCard key={book.id} book={book} viewMode={viewMode} />
              ))}
              {visibleBooks.length === 0 && <p className="management-empty">No books match this filter.</p>}
            </div>
          </>
        )}
      </section>
    </DashboardShell>
  );
}
