import { useEffect, useMemo, useState } from "react";
import { BookOpen, Headphones, LibraryBig, Search, SortAsc, UserRound } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { SelectMenu } from "../../shared/SelectMenu";
import { AudiobookPageHeader } from "./AudiobooksPage";

type KindFilter = "all" | "audiobook" | "ebook";
type NameOrder = "first" | "last";
type AuthorSummary = {
  name: string;
  sortName: string | null;
  audiobookCount: number;
  ebookCount: number;
  libraryIds: string[];
};
type AuthorLibrary = { id: string; name: string; type: string };

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
// Everything that isn't a Latin letter indexes here: digits, punctuation, and
// names in scripts this strip can't represent. Better one bucket that always has
// the author in it than 26 buttons they can never be found under.
const OTHER = "#";

// Common generational and honorific suffixes. They're the last token of a name
// without ever being the surname, so a last-name index has to look past them.
const SUFFIXES = new Set(["jr", "jr.", "sr", "sr.", "i", "ii", "iii", "iv", "v", "phd", "ph.d.", "md", "esq"]);

// The surname to file an author under. A curated sort name wins when it has one
// ("Tolkien, J. R. R." → Tolkien), since a person set it deliberately. Otherwise
// take the last word of the name, stepping back over any suffix. The scanner
// seeds sort_name from the title-sort helper — which only strips leading
// articles — so most authors reach this with a sort name that is just their name
// again, and the fallback is what actually does the work.
function surnameOf(author: AuthorSummary): string {
  const sortName = author.sortName?.trim();
  if (sortName && sortName.includes(",")) return sortName.split(",")[0].trim();

  const words = author.name.trim().split(/\s+/).filter(Boolean);
  for (let i = words.length - 1; i >= 0; i -= 1) {
    if (!SUFFIXES.has(words[i].toLowerCase())) return words[i];
  }
  return author.name.trim();
}

// The A–Z bucket a string falls in. Accents are folded so "Ángela" files under A
// rather than disappearing into "#".
function letterOf(value: string): string {
  const first = value.normalize("NFD").replace(/\p{M}/gu, "").trim().charAt(0).toUpperCase();
  return first >= "A" && first <= "Z" ? first : OTHER;
}

// The single, cross-type Authors browse (replaces the old per-section author
// lists). Authors are global, so one list spans audiobooks + ebooks. Four filters
// narrow it — search, media type, library, and the A–Z strip — and the First/Last
// name choice drives both which letter an author files under and the sort order,
// because those are the same question asked twice.
export function AuthorListPage({
  user,
  logout
}: {
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const [authors, setAuthors] = useState<AuthorSummary[]>([]);
  const [libraries, setLibraries] = useState<AuthorLibrary[]>([]);
  const [photos, setPhotos] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [libraryFilter, setLibraryFilter] = useState("all");
  const [nameOrder, setNameOrder] = useState<NameOrder>("first");
  const [letter, setLetter] = useState("");

  useEffect(() => {
    api<{ authors: AuthorSummary[]; libraries: AuthorLibrary[] }>("/api/library/people/authors")
      .then((payload) => {
        setAuthors(payload.authors);
        setLibraries(payload.libraries);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load authors"));
    api<{ photos: Record<string, string> }>("/api/library/people/photos")
      .then((payload) => setPhotos(payload.photos))
      .catch(() => {}); // avatars are decoration — the list works without them
  }, []);

  // The name each author is indexed and sorted by under the current choice.
  const indexNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const author of authors) {
      map.set(author.name, nameOrder === "last" ? surnameOf(author) : author.name.trim());
    }
    return map;
  }, [authors, nameOrder]);

  const indexName = (author: AuthorSummary) => indexNames.get(author.name) ?? author.name;

  // Toggle counts = how many authors fall in each media type; the toggle only
  // appears when authors actually span both types.
  const audiobookAuthors = authors.filter((a) => a.audiobookCount > 0).length;
  const ebookAuthors = authors.filter((a) => a.ebookCount > 0).length;
  const hasBothTypes = audiobookAuthors > 0 && ebookAuthors > 0;

  // The title count on each card, scoped to the active filter.
  const cardCount = (a: AuthorSummary) =>
    kindFilter === "audiobook" ? a.audiobookCount
      : kindFilter === "ebook" ? a.ebookCount
        : a.audiobookCount + a.ebookCount;

  const term = search.trim().toLowerCase();
  const matchesKind = (a: AuthorSummary) =>
    kindFilter === "all" || (kindFilter === "audiobook" ? a.audiobookCount > 0 : a.ebookCount > 0);
  const matchesLibrary = (a: AuthorSummary) =>
    libraryFilter === "all" || a.libraryIds.includes(libraryFilter);
  const matchesSearch = (a: AuthorSummary) => !term || a.name.toLowerCase().includes(term);

  // Which letters to offer. Computed from everything the OTHER filters allow, not
  // from the final list, so picking a letter never empties the strip that picked
  // it — and a letter with nothing behind it is disabled rather than hidden, so
  // the row doesn't reflow under the pointer as filters change.
  const availableLetters = useMemo(() => {
    const seen = new Set<string>();
    for (const author of authors) {
      if (matchesKind(author) && matchesLibrary(author) && matchesSearch(author)) {
        seen.add(letterOf(indexName(author)));
      }
    }
    return seen;
    // Deps are the filter inputs, not the match helpers closing over them: those
    // are re-made every render and would defeat the memo entirely.
  }, [authors, kindFilter, libraryFilter, term, indexNames]);

  const shown = authors
    .filter((a) => matchesKind(a) && matchesLibrary(a) && matchesSearch(a))
    .filter((a) => !letter || letterOf(indexName(a)) === letter)
    .slice()
    .sort((a, b) => indexName(a).localeCompare(indexName(b), undefined, { sensitivity: "base" }));

  const libraryOptions = [
    { value: "all", label: "All libraries" },
    ...libraries.map((lib) => ({ value: lib.id, label: lib.name }))
  ];

  return (
    <DashboardShell active="authors" user={user} logout={logout}>
      <section className="audiobook-main-page">
        <AudiobookPageHeader
          title="Authors"
          subtitle={`${shown.length} ${shown.length === 1 ? "author" : "authors"}`}
        />

        {error && <MessageBox tone="error" title="Authors error">{error}</MessageBox>}

        {authors.length > 0 && (
          <div className="audiobook-toolbar">
            <label className="search-field">
              <Search size={17} aria-hidden="true" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search authors"
                aria-label="Search authors"
              />
            </label>
            <SelectMenu
              value={nameOrder}
              label="Sort and index by"
              triggerIcon={<SortAsc size={15} aria-hidden="true" />}
              onChange={setNameOrder}
              options={[
                { value: "first", label: "First name" },
                { value: "last", label: "Last name" }
              ]}
            />
            {libraries.length > 1 && (
              <SelectMenu
                value={libraryFilter}
                label="Library"
                triggerIcon={<LibraryBig size={15} aria-hidden="true" />}
                onChange={setLibraryFilter}
                options={libraryOptions}
              />
            )}
          </div>
        )}

        {hasBothTypes && (
          <div className="kind-toggle" role="group" aria-label="Filter by media type">
            <button type="button" className={kindFilter === "all" ? "is-active" : ""} onClick={() => setKindFilter("all")}>
              All<span className="kind-toggle-count">{authors.length}</span>
            </button>
            <button type="button" className={kindFilter === "audiobook" ? "is-active" : ""} onClick={() => setKindFilter("audiobook")}>
              <Headphones size={15} aria-hidden="true" />Audiobooks<span className="kind-toggle-count">{audiobookAuthors}</span>
            </button>
            <button type="button" className={kindFilter === "ebook" ? "is-active" : ""} onClick={() => setKindFilter("ebook")}>
              <BookOpen size={15} aria-hidden="true" />Ebooks<span className="kind-toggle-count">{ebookAuthors}</span>
            </button>
          </div>
        )}

        {authors.length > 0 && (
          <div className="alpha-filter" role="group" aria-label={`Filter by ${nameOrder} letter`}>
            <button
              type="button"
              className={letter === "" ? "is-active" : ""}
              onClick={() => setLetter("")}
            >
              All
            </button>
            {[...ALPHABET, OTHER].map((option) => (
              <button
                key={option}
                type="button"
                className={letter === option ? "is-active" : ""}
                disabled={!availableLetters.has(option)}
                aria-label={option === OTHER ? "Names starting with a number or symbol" : option}
                onClick={() => setLetter((current) => (current === option ? "" : option))}
              >
                {option}
              </button>
            ))}
          </div>
        )}

        {shown.length === 0 ? (
          <div className="empty-state library-empty">
            <UserRound size={48} aria-hidden="true" />
            <h2>No authors{term || letter || libraryFilter !== "all" ? " match" : " yet"}</h2>
          </div>
        ) : (
          <div className="person-grid">
            {shown.map((author) => (
              <button
                key={author.name}
                className="person-card"
                onClick={() => navigate(`/people/${encodeURIComponent(author.name)}?from=${encodeURIComponent("/authors")}`)}
              >
                <div className="person-avatar" aria-hidden="true">
                  {photos[author.name] ? <img src={photos[author.name]} alt="" /> : <UserRound size={26} />}
                </div>
                <div className="person-card-body">
                  <strong>{author.name}</strong>
                  <span>{cardCount(author)} {cardCount(author) === 1 ? "title" : "titles"}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>
    </DashboardShell>
  );
}
