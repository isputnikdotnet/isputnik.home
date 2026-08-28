import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, Headphones, LibraryBig, UserPlus, UserRound } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate, queryParam, replaceQuery } from "../../router";
import { AlphabetBar } from "../../shared/AlphabetBar";
import { Button } from "../../shared/Button";
import { LibraryPageHeader } from "../../shared/LibraryPageHeader";
import { LibraryMenu } from "../../shared/LibraryMenu";
import { LibraryPageToolbar } from "../../shared/LibraryPageToolbar";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { SectionNav } from "../../shared/SectionNav";
import { SortMenu } from "../../shared/SortMenu";
import { sectionFromQuery, sectionNavProps } from "./sectionNavItems";

type KindFilter = "all" | "audiobook" | "ebook";
type NameOrder = "first" | "last";
type AuthorSummary = {
  name: string;
  sortName: string | null;
  audiobookCount: number;
  ebookCount: number;
  libraryIds: string[];
  // Both ways this list can be indexed, bucketed and ordered by the server (see
  // modules/library/shared/alphabet.ts). Script detection and Cyrillic folding
  // live there once, rather than in every page that draws a strip.
  alphaKey: string;
  alphaKeyLast: string;
  sortKey: string;
  sortKeyLast: string;
};
type AuthorLibrary = { id: string; name: string; type: string };

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
  const { t } = useTranslation(["common", "book"]);
  const [authors, setAuthors] = useState<AuthorSummary[]>([]);
  const [libraries, setLibraries] = useState<AuthorLibrary[]>([]);
  const [photos, setPhotos] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [libraryFilter, setLibraryFilter] = useState("all");
  const [nameOrder, setNameOrder] = useState<NameOrder>("first");
  // The letter is navigation-shaped: it comes off the URL so a reload or a shared
  // link opens on it, and goes back with replaceState so Back leaves the page
  // instead of walking out through every letter that was clicked.
  const [letter, setLetter] = useState<string | null>(() => queryParam("letter"));
  // People are global rows, so creating one asks for no library — the server
  // answers whether this user may write ANY book library, which is the whole
  // permission question here.
  const [canCreate, setCanCreate] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSortName, setNewSortName] = useState("");
  const [newBio, setNewBio] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const section = sectionFromQuery();

  useEffect(() => {
    replaceQuery("letter", letter);
  }, [letter]);

  useEffect(() => {
    api<{ authors: AuthorSummary[]; libraries: AuthorLibrary[]; canCreate: boolean }>("/api/library/people/authors")
      .then((payload) => {
        setAuthors(payload.authors);
        setLibraries(payload.libraries);
        setCanCreate(payload.canCreate);
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("book:authors.unableLoad")));
    api<{ photos: Record<string, string> }>("/api/library/people/photos")
      .then((payload) => setPhotos(payload.photos))
      .catch(() => {}); // avatars are decoration — the list works without them
  }, []);

  // Which of the server's two indexes the First/Last choice selects — the letter
  // an author files under and the value the list sorts by are the same question
  // asked twice, so they always come from the same pair.
  const bucketOf = (author: AuthorSummary) => (nameOrder === "last" ? author.alphaKeyLast : author.alphaKey);
  const orderOf = (author: AuthorSummary) => (nameOrder === "last" ? author.sortKeyLast : author.sortKey);

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
        seen.add(bucketOf(author));
      }
    }
    return [...seen];
    // Deps are the filter inputs, not the match helpers closing over them: those
    // are re-made every render and would defeat the memo entirely.
  }, [authors, kindFilter, libraryFilter, term, nameOrder]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = authors
    .filter((a) => matchesKind(a) && matchesLibrary(a) && matchesSearch(a))
    .filter((a) => !letter || bucketOf(a) === letter)
    .slice()
    // Ordered by the server's sort key, which is already folded (Ё → Е, accents
    // stripped), so a plain comparison puts Cyrillic and Latin names in the order
    // a reader expects.
    .sort((a, b) => orderOf(a).localeCompare(orderOf(b)));

  const libraryOptions = [
    { value: "all", label: t("book:catalog.allLibraries") },
    ...libraries.map((lib) => ({ value: lib.id, label: lib.name }))
  ];

  // Where an author's page returns to. Carrying the section along means the trip
  // out to /people/:name and back doesn't drop the Ebooks/Audiobooks nav this
  // list was reached under.
  const backHref = `/authors${section ? `?section=${section.active}` : ""}`;

  const openCreate = () => {
    setNewName("");
    setNewSortName("");
    setNewBio("");
    setCreateError("");
    setCreateOpen(true);
  };

  const createAuthor = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setCreateError("");
    try {
      await api("/api/library/people", {
        method: "POST",
        body: JSON.stringify({
          name,
          sortName: newSortName.trim() || null,
          bio: newBio.trim() || null
        })
      });
      // Straight to the new profile: creating an author is almost always the
      // first half of filling one in (photo, bio, website).
      navigate(`/people/${encodeURIComponent(name)}?from=${encodeURIComponent(backHref)}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : t("book:authors.unableCreate"));
      setCreating(false);
    }
  };

  return (
    <DashboardShell
      active={section?.active ?? "authors"}
      user={user}
      logout={logout}
      sideNav={section && <SectionNav {...sectionNavProps(section)} activeKey="authors" />}
    >
      <section className="audiobook-main-page">
        <LibraryPageHeader
          title={t("book:authors.title")}
          subtitle={t("book:catalog.counts.author", { count: shown.length })}
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder={t("book:authors.searchPlaceholder")}
          primaryAction={canCreate && (
            <Button variant="primary" onClick={openCreate}>
              <UserPlus size={16} aria-hidden="true" />
              <span>{t("book:authors.newAuthor")}</span>
            </Button>
          )}
        />

        {error && <MessageBox tone="error" title={t("book:authors.errorTitle")}>{error}</MessageBox>}

        {authors.length > 0 && (
          <LibraryPageToolbar
            // Same left-to-right reading as the book pages: what the page is scoped
            // to (library, then media type) on the left, the controls that reorder
            // what it found on the right. The media-type toggle appears only where
            // it does something — a shelf of audiobooks alone has nothing to switch.
            scope={
              <>
                {libraries.length > 1 && (
                  <LibraryMenu
                    value={libraryFilter}
                    options={libraryOptions}
                    icon={<LibraryBig size={19} aria-hidden="true" />}
                    label={t("book:detail.rows.library")}
                    onChange={setLibraryFilter}
                  />
                )}
                {hasBothTypes && (
                  <div className="kind-toggle" role="group" aria-label={t("book:people.filterByMediaTypeAria")}>
                    <button type="button" className={kindFilter === "all" ? "is-active" : ""} onClick={() => setKindFilter("all")}>
                      {t("common:common.all")}<span className="kind-toggle-count">{authors.length}</span>
                    </button>
                    <button type="button" className={kindFilter === "audiobook" ? "is-active" : ""} onClick={() => setKindFilter("audiobook")}>
                      <Headphones size={15} aria-hidden="true" />{t("common:nav.audiobooks")}<span className="kind-toggle-count">{audiobookAuthors}</span>
                    </button>
                    <button type="button" className={kindFilter === "ebook" ? "is-active" : ""} onClick={() => setKindFilter("ebook")}>
                      <BookOpen size={15} aria-hidden="true" />{t("common:nav.ebooks")}<span className="kind-toggle-count">{ebookAuthors}</span>
                    </button>
                  </div>
                )}
              </>
            }
            tools={
              <SortMenu
                presentation="labelled"
                value={nameOrder}
                ariaLabel={t("book:people.sortAndIndexByAria")}
                onChange={setNameOrder}
                options={[
                  { value: "first", label: t("book:people.orderFirstName") },
                  { value: "last", label: t("book:people.orderLastName") }
                ]}
              />
            }
            strip={
              <AlphabetBar
                available={availableLetters}
                value={letter}
                onChange={setLetter}
                ariaLabel={nameOrder === "last" ? t("book:people.filterByLastLetter") : t("book:people.filterByFirstLetter")}
              />
            }
          />
        )}

        {shown.length === 0 ? (
          <div className="empty-state library-empty">
            <UserRound size={48} aria-hidden="true" />
            <h2>{term || letter || libraryFilter !== "all" ? t("book:authors.noneMatch") : t("book:authors.noneYet")}</h2>
          </div>
        ) : (
          <div className="person-grid">
            {shown.map((author) => (
              <button
                key={author.name}
                className="person-card"
                onClick={() => navigate(`/people/${encodeURIComponent(author.name)}?from=${encodeURIComponent(backHref)}`)}
              >
                <div className="person-avatar" aria-hidden="true">
                  {photos[author.name] ? <img src={photos[author.name]} alt="" /> : <UserRound size={26} />}
                </div>
                <div className="person-card-body">
                  <strong>{author.name}</strong>
                  <span>{t("book:catalog.counts.title", { count: cardCount(author) })}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      {createOpen && (
        <Modal title={t("book:authors.newAuthorModalTitle")} busy={creating} onClose={() => setCreateOpen(false)}>
          <p className="muted">{t("book:authors.newAuthorIntro")}</p>
          {createError && <MessageBox tone="error" title={t("book:authors.unableCreate")}>{createError}</MessageBox>}
          <label className="field">
            <span>{t("book:person.fieldName")}</span>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t("book:authors.namePlaceholder")}
              autoFocus
            />
          </label>
          <label className="field">
            <span>{t("book:person.fieldSortName")} <span className="muted">{t("book:authors.optional")}</span></span>
            <input
              value={newSortName}
              onChange={(e) => setNewSortName(e.target.value)}
              placeholder={t("book:person.sortExample", {
                example: newName.trim() ? newName.trim().split(" ").reverse().join(", ") : "Rand, Ayn"
              })}
            />
          </label>
          <label className="field">
            <span>{t("book:person.fieldBiography")} <span className="muted">{t("book:authors.optional")}</span></span>
            <textarea
              rows={5}
              value={newBio}
              onChange={(e) => setNewBio(e.target.value)}
              placeholder={t("book:person.bioPlaceholder")}
              maxLength={10000}
            />
          </label>
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={creating}>
              {t("common:common.cancel")}
            </Button>
            <Button variant="primary" onClick={() => void createAuthor()} disabled={creating || !newName.trim()}>
              <UserPlus size={15} aria-hidden="true" />
              <span>{creating ? t("book:authors.creating") : t("book:authors.createAuthorButton")}</span>
            </Button>
          </div>
        </Modal>
      )}
    </DashboardShell>
  );
}
