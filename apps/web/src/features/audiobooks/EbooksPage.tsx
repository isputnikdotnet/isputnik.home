import { useEffect, useState } from "react";
import { BookMarked, Search } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { formatBytes } from "../../shared/utils";
import {
  EMPTY_FILTERS, FilterButton, FilterChips, SortSelect, filterBooks, sortBooks, facetsFromBooks,
  type BookFilters, type SortKey, type FilterableBook
} from "./BookFilter";

interface EbookLibrary {
  id: string;
  name: string;
}

function EbookCard({ book }: { book: FilterableBook }) {
  return (
    <button className="audiobook-card" onClick={() => navigate(`/ebooks/books/${book.id}`)}>
      <div className="audiobook-cover" aria-hidden="true">
        {book.coverUrl ? (
          <img src={book.coverUrl} alt="" />
        ) : (
          <>
            <BookMarked size={13} />
            <strong>{book.title.slice(0, 2).toUpperCase()}</strong>
          </>
        )}
      </div>
      <div className="audiobook-card-body">
        <strong>{book.title}</strong>
        <span>{book.authors.length > 0 ? book.authors.join(", ") : "Unknown author"}</span>
        <small>
          {(book as FilterableBook & { format?: string }).format?.toUpperCase() ?? "EBOOK"}
          {book.totalSize ? ` · ${formatBytes(book.totalSize)}` : ""}
        </small>
      </div>
    </button>
  );
}

export function EbooksPage({ user, logout }: { user: PublicUser; logout: () => Promise<void> }) {
  const [libraries, setLibraries] = useState<EbookLibrary[]>([]);
  const [booksByLibrary, setBooksByLibrary] = useState<Record<string, FilterableBook[]>>({});
  const [selectedLibraryId, setSelectedLibraryId] = useState("all");
  const [filters, setFilters] = useState<BookFilters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<SortKey>("title");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api<{ libraries: EbookLibrary[] }>("/api/library/ebook-libraries")
      .then(async (payload) => {
        setLibraries(payload.libraries);
        const lists = await Promise.all(
          payload.libraries.map((lib) =>
            api<{ books: FilterableBook[] }>(`/api/library/ebook-libraries/${lib.id}/books`)
              .then((p) => [lib.id, p.books.map((b) => ({ ...b, libraryName: lib.name }))] as const)
          )
        );
        setBooksByLibrary(Object.fromEntries(lists));
        setLoaded(true);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load ebooks"));
  }, []);

  const allBooks = libraries.flatMap((lib) => booksByLibrary[lib.id] ?? []);
  const term = search.trim().toLowerCase();
  const searched = allBooks.filter((book) => {
    if (selectedLibraryId !== "all" && book.libraryId !== selectedLibraryId) return false;
    if (term) {
      const haystack = [book.title, book.libraryName, ...book.authors];
      if (!haystack.some((v) => v?.toLowerCase().includes(term))) return false;
    }
    return true;
  });
  const visibleBooks = sortBooks(filterBooks(searched, filters), sort);

  return (
    <DashboardShell active="ebooks" user={user} logout={logout}>
      <section className="work-area scene-page audiobook-scene audiobook-area">
        <div className="section-head audiobook-head">
          <div>
            <p className="eyebrow">Digital Library</p>
            <h1>Ebooks</h1>
          </div>
        </div>

        {error && <MessageBox tone="error" title="Ebooks error">{error}</MessageBox>}

        {loaded && allBooks.length === 0 ? (
          <div className="empty-state library-empty">
            <BookMarked size={58} aria-hidden="true" />
            <h2>No ebooks yet</h2>
            <p className="muted">An administrator can add an ebook library from the control panel.</p>
          </div>
        ) : (
          <>
            <div className="audiobook-toolbar">
              <label className="search-field">
                <Search size={17} aria-hidden="true" />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search title or author"
                  aria-label="Search ebooks"
                />
              </label>
              {libraries.length > 1 && (
                <select className="library-filter" value={selectedLibraryId} onChange={(e) => setSelectedLibraryId(e.target.value)} aria-label="Filter by library">
                  <option value="all">All libraries</option>
                  {libraries.map((lib) => <option key={lib.id} value={lib.id}>{lib.name}</option>)}
                </select>
              )}
              <FilterButton facets={facetsFromBooks(allBooks)} value={filters} onChange={setFilters} />
              <SortSelect value={sort} onChange={setSort} />
              <span>{visibleBooks.length} {visibleBooks.length === 1 ? "book" : "books"}</span>
            </div>

            <FilterChips value={filters} onChange={setFilters} />

            <div className="audiobook-grid">
              {visibleBooks.map((book) => <EbookCard key={book.id} book={book} />)}
              {loaded && visibleBooks.length === 0 && <p className="management-empty">No ebooks match this filter.</p>}
            </div>
          </>
        )}
      </section>
    </DashboardShell>
  );
}
