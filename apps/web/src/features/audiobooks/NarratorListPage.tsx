import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LibraryBig, UserPlus, UserRound } from "lucide-react";
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
import { bookSectionNav, sectionNavProps } from "./sectionNavItems";
import type { AudiobookLibrary } from "./types";

// Same payload shape the Authors browse gets — the counts plus the server's
// alphabet index (see modules/library/shared/alphabet.ts). Narrators are an
// audiobook-only credit, so only audiobookCount is ever non-zero.
type NarratorSummary = {
  name: string;
  audiobookCount: number;
  libraryIds: string[];
  alphaKey: string;
  alphaKeyLast: string;
  sortKey: string;
  sortKeyLast: string;
};

type NameOrder = "first" | "last";

// Narrators are an audiobook-only credit, so this list stays per-section (unlike
// Authors, which are unified across types in AuthorListPage). Each narrator
// still opens the cross-type person page at /people/:name.
export function NarratorListPage({
  user,
  logout
}: {
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const { t } = useTranslation(["common", "book"]);
  const [libraries, setLibraries] = useState<AudiobookLibrary[]>([]);
  const [persons, setPersons] = useState<NarratorSummary[]>([]);
  const [photos, setPhotos] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [libraryFilter, setLibraryFilter] = useState("all");
  const [nameOrder, setNameOrder] = useState<NameOrder>("first");
  // Navigation-shaped like the Authors strip: off the URL, back with replaceState.
  const [letter, setLetter] = useState<string | null>(() => queryParam("letter"));
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newLibraryId, setNewLibraryId] = useState("");
  const [newBio, setNewBio] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  useEffect(() => {
    replaceQuery("letter", letter);
  }, [letter]);

  useEffect(() => {
    // One request for the whole list, indexed and counted by the server. This
    // page used to derive its narrators by downloading every book of every
    // library and folding them client-side.
    api<{ narrators: NarratorSummary[] }>("/api/library/people/narrators")
      .then((payload) => setPersons(payload.narrators))
      .catch((err) => setError(err instanceof Error ? err.message : t("book:narrators.unableLoad")));
    // The libraries list is still needed: it gates "New narrator" on write access.
    api<{ libraries: AudiobookLibrary[] }>("/api/library/audiobook-libraries")
      .then((payload) => setLibraries(payload.libraries))
      .catch((err) => setError(err instanceof Error ? err.message : t("book:catalog.unableLoadData")));
    api<{ photos: Record<string, string> }>("/api/library/people/photos")
      .then((payload) => setPhotos(payload.photos))
      .catch(() => {}); // avatars are decoration — the list works without them
  }, []);

  const term = search.trim().toLowerCase();
  const matchesSearch = (person: NarratorSummary) => !term || person.name.toLowerCase().includes(term);
  const matchesLibrary = (person: NarratorSummary) =>
    libraryFilter === "all" || person.libraryIds.includes(libraryFilter);

  // Which of the server's two indexes the First/Last choice selects — the letter a
  // narrator files under and the order they sort in are the same question twice.
  const bucketOf = (person: NarratorSummary) => (nameOrder === "last" ? person.alphaKeyLast : person.alphaKey);
  const orderOf = (person: NarratorSummary) => (nameOrder === "last" ? person.sortKeyLast : person.sortKey);

  // Offered from everything the OTHER filters allow, so choosing a letter never
  // empties the strip that chose it.
  const availableLetters = [
    ...new Set(persons.filter((p) => matchesSearch(p) && matchesLibrary(p)).map(bucketOf))
  ];

  const filtered = persons
    .filter((person) => matchesSearch(person) && matchesLibrary(person) && (!letter || bucketOf(person) === letter))
    .slice()
    // The server's sort key is already folded (Ё → Е, accents stripped).
    .sort((a, b) => orderOf(a).localeCompare(orderOf(b)));

  const libraryOptions = [
    { value: "all", label: t("book:catalog.allLibraries") },
    ...libraries.map((lib) => ({ value: lib.id, label: lib.name }))
  ];

  // Everyone lands on the canonical, cross-type person page; `from` lets its
  // Back button return to this list.
  const personHref = (name: string) =>
    `/people/${encodeURIComponent(name)}?from=${encodeURIComponent(window.location.pathname)}`;
  const writableLibraries = libraries.filter((lib) => lib.canWrite);
  const canCreate = writableLibraries.length > 0;

  const openCreate = () => {
    setNewName("");
    setNewBio("");
    setNewLibraryId(writableLibraries.length === 1 ? writableLibraries[0].id : "");
    setCreateError("");
    setCreateOpen(true);
  };

  const createNarrator = async () => {
    const name = newName.trim();
    if (!name || !newLibraryId) return;
    setCreating(true);
    setCreateError("");
    try {
      await api("/api/library/people", {
        method: "POST",
        body: JSON.stringify({ name, libraryId: newLibraryId, bio: newBio.trim() || null })
      });
      navigate(`/people/${encodeURIComponent(name)}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : t("book:narrators.unableCreate"));
      setCreating(false);
    }
  };

  return (
    <DashboardShell
      active="audiobooks"
      user={user}
      logout={logout}
      sideNav={<SectionNav {...sectionNavProps(bookSectionNav("audiobook"))} activeKey="narrators" />}
    >
      <section className="audiobook-main-page">
        <LibraryPageHeader
          title={t("book:narrators.title")}
          subtitle={t("book:catalog.counts.narrator", { count: filtered.length })}
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder={t("book:narrators.searchPlaceholder")}
          primaryAction={canCreate && (
            <Button variant="primary" onClick={openCreate}>
              <UserPlus size={16} aria-hidden="true" />
              <span>{t("book:narrators.newNarrator")}</span>
            </Button>
          )}
        />

        {error && <MessageBox tone="error" title={t("book:detail.errorTitle")}>{error}</MessageBox>}

        {persons.length > 0 && (
          <LibraryPageToolbar
            scope={libraries.length > 1 && (
              <LibraryMenu
                value={libraryFilter}
                options={libraryOptions}
                icon={<LibraryBig size={19} aria-hidden="true" />}
                label={t("book:detail.rows.library")}
                onChange={setLibraryFilter}
              />
            )}
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

        {libraries.length === 0 ? (
          <div className="empty-state library-empty">
            <UserRound size={58} aria-hidden="true" />
            <h2>{t("book:catalog.noAudiobookLibraries")}</h2>
            <p className="muted">{t("book:catalog.adminAddLibraries")}</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state library-empty">
            <UserRound size={48} aria-hidden="true" />
            <h2>{t("book:narrators.noneMatch")}</h2>
          </div>
        ) : (
          <div className="person-grid">
            {filtered.map((person) => (
              <button
                key={person.name}
                className="person-card"
                onClick={() => navigate(personHref(person.name))}
              >
                <div className="person-avatar" aria-hidden="true">
                  {photos[person.name] ? (
                    <img src={photos[person.name]} alt="" />
                  ) : (
                    <UserRound size={26} />
                  )}
                </div>
                <div className="person-card-body">
                  <strong>{person.name}</strong>
                  <span>{t("book:catalog.counts.book", { count: person.audiobookCount })}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      {createOpen && (
        <Modal title={t("book:narrators.newNarratorModalTitle")} busy={creating} onClose={() => setCreateOpen(false)}>
          <p className="muted">
            {t("book:narrators.newNarratorIntro")}
          </p>
          {createError && <MessageBox tone="error" title={t("book:narrators.unableCreate")}>{createError}</MessageBox>}
          <label className="field">
            <span>{t("book:person.fieldName")}</span>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t("book:narrators.namePlaceholder")} autoFocus />
          </label>
          {writableLibraries.length > 1 && (
            <label className="field">
              <span>{t("book:detail.rows.library")}</span>
              <select value={newLibraryId} onChange={(e) => setNewLibraryId(e.target.value)}>
                <option value="">{t("book:narrators.chooseLibraryPlaceholder")}</option>
                {writableLibraries.map((lib) => (
                  <option key={lib.id} value={lib.id}>{lib.name}</option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>{t("book:person.fieldBiography")} <span className="muted">{t("book:narrators.optional")}</span></span>
            <textarea
              rows={5}
              value={newBio}
              onChange={(e) => setNewBio(e.target.value)}
              placeholder={t("book:person.bioPlaceholder")}
              maxLength={10000}
            />
          </label>
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={creating}>{t("common:common.cancel")}</Button>
            <Button variant="primary" onClick={createNarrator} disabled={creating || !newName.trim() || !newLibraryId}>
              <UserPlus size={15} />
              <span>{creating ? t("book:narrators.creating") : t("book:narrators.createNarratorButton")}</span>
            </Button>
          </div>
        </Modal>
      )}
    </DashboardShell>
  );
}
