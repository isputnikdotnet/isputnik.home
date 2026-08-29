import { useEffect, useMemo, useState } from "react";
import { CheckCheck, CheckSquare, Settings, Square, Tags, UserRoundPlus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { followRoute, navigate } from "../../router";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { LibraryPageHeader } from "../../shared/LibraryPageHeader";
import { LibraryPageToolbar } from "../../shared/LibraryPageToolbar";
import { SectionNav } from "../../shared/SectionNav";
import { familyNavProps } from "./sectionNavItems";
import { BulkTagPeopleModal } from "./BulkTagPeopleModal";
import { FamilyTreeSettingsModal } from "./FamilyTreeSettingsModal";
import { PersonAvatar } from "./PersonAvatar";
import { PersonEditModal } from "./PersonEditModal";
import { lifeYears, type FamilyPerson, type FamilyTreeAccess } from "./types";

// Every family member as a searchable grid — the management/finding surface
// beside the chart. Cards open the profile. Tags (family branches) act as a
// filter here and, for admins, as the edit-permission scope (Branch access).
export function FamilyPeoplePage({ user, logout }: { user: PublicUser; logout: () => Promise<void> }) {
  const { t } = useTranslation(["common", "family"]);
  const [persons, setPersons] = useState<FamilyPerson[]>([]);
  const [access, setAccess] = useState<FamilyTreeAccess | null>(null);
  const [search, setSearch] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  // Admin-only bulk tagging: tags are the edit-permission scope, so handing a
  // branch to someone means tagging everyone in it at once.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [tagOpen, setTagOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const isAdmin = user.role === "admin";

  useEffect(() => {
    api<{ persons: FamilyPerson[]; access: FamilyTreeAccess }>("/api/family-tree/persons")
      .then((payload) => { setPersons(payload.persons); setAccess(payload.access); })
      .catch((err) => setError(err instanceof Error ? err.message : t("family:people.errors.loadPersons")));
  }, [t]);

  // Tag filter chips come from the loaded persons, so counts match the grid.
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const person of persons) {
      for (const tag of person.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [persons]);

  const term = search.trim().toLowerCase();
  const shown = useMemo(
    () =>
      persons.filter((p) =>
        (!term || p.name.toLowerCase().includes(term) || p.maidenName?.toLowerCase().includes(term))
        && (!activeTag || p.tags.includes(activeTag))
      ),
    [persons, term, activeTag]
  );

  const selectedPersons = useMemo(
    () => persons.filter((person) => selectedIds.has(person.id)),
    [persons, selectedIds]
  );

  const exitSelection = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  };

  const toggleSelected = (id: string) =>
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <DashboardShell active="family" user={user} logout={logout} sideNav={<SectionNav {...familyNavProps("people")} />}>
      <section className="audiobook-main-page">
        {/* Families and the chart are one click away in the left nav now, so the
            links that used to sit here — and the "Back to the tree" above them —
            are gone; the header carries only what acts on this page. */}
        <LibraryPageHeader
          title={t("family:people.title")}
          subtitle={t("family:common.counts.person", { count: shown.length })}
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder={t("family:people.searchPlaceholder")}
          actions={isAdmin && (
            <Button
              variant="icon"
              className="audiobook-page-action-icon"
              aria-label={t("family:treeSettings.title")}
              title={t("family:treeSettings.title")}
              onClick={() => setAccessOpen(true)}
            >
              <Settings size={18} aria-hidden="true" />
            </Button>
          )}
          primaryAction={access?.canAdd && (
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              <UserRoundPlus size={16} aria-hidden="true" />
              <span>{t("family:common.addPerson")}</span>
            </Button>
          )}
        />

        {/* The tag chips ride the toolbar's strip row — the same slot the A–Z
            index uses on the book pages — so filtering and selecting live in
            one card and nothing below moves when a selection starts. */}
        <LibraryPageToolbar
          tools={isAdmin && persons.length > 0 && (
            <button
              type="button"
              className="library-toolbar-button"
              onClick={() => { setSelectionMode(true); setNotice(""); }}
            >
              <CheckSquare size={18} aria-hidden="true" />
              <span className="toolbar-label">{t("family:people.select")}</span>
            </button>
          )}
          selection={selectionMode ? {
            count: selectedIds.size,
            actions: (
              <>
                <button
                  type="button"
                  className="library-toolbar-button"
                  onClick={() => setSelectedIds(new Set(shown.map((person) => person.id)))}
                  disabled={shown.length === 0}
                  title={t("family:people.selectAllShownTitle")}
                >
                  <CheckCheck size={18} aria-hidden="true" />
                  <span className="toolbar-label">{t("family:people.selectAll")}</span>
                </button>
                <button
                  type="button"
                  className="library-toolbar-button primary"
                  onClick={() => { setNotice(""); setTagOpen(true); }}
                  disabled={selectedIds.size === 0}
                  title={t("family:people.tagSelectedTitle")}
                >
                  <Tags size={18} aria-hidden="true" />
                  <span className="toolbar-label">{t("family:people.tagSelected")}</span>
                </button>
                <span className="library-toolbar-divider" aria-hidden="true" />
                <button
                  type="button"
                  className="library-toolbar-button"
                  onClick={exitSelection}
                  title={t("family:people.leaveSelection")}
                >
                  <X size={18} aria-hidden="true" />
                  <span className="toolbar-label">{t("common.done")}</span>
                </button>
              </>
            )
          } : null}
          strip={tagCounts.length > 0 && (
            <div className="ft-tag-filter" role="group" aria-label={t("family:people.filterByTagAria")}>
              {tagCounts.map(([tag, count]) => (
                <button
                  key={tag}
                  type="button"
                  className={`book-tag-chip book-tag-chip-tag${activeTag === tag ? " ft-tag-chip-active" : ""}`}
                  aria-pressed={activeTag === tag}
                  title={`${tag} · ${count}`}
                  onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                >
                  {tag} · {count}
                </button>
              ))}
            </div>
          )}
        />

        {error && <MessageBox tone="error" title={t("family:people.errorTitle")}>{error}</MessageBox>}
        {notice && <MessageBox tone="success" title={t("family:people.tagsUpdatedTitle")}>{notice}</MessageBox>}

        {shown.length === 0 ? (
          <p className="management-empty">
            {persons.length === 0
              ? access?.canAdd
                ? t("family:people.emptyNoneCanAdd")
                : t("family:people.emptyNoneCannotAdd")
              : t("family:people.emptyNoMatches")}
          </p>
        ) : (
          <div className="ft-people-grid">
            {shown.map((person) => {
              const meta =
                [person.maidenName ? t("family:common.nee", { name: person.maidenName }) : "", lifeYears(person)]
                  .filter(Boolean)
                  .join(" · ") || " ";
              // While selecting, the card picks instead of navigating — a link
              // that sometimes leaves the page mid-selection loses the set.
              return selectionMode ? (
                <button
                  key={person.id}
                  type="button"
                  className={`ft-person-card${selectedIds.has(person.id) ? " is-selected" : ""}`}
                  aria-pressed={selectedIds.has(person.id)}
                  onClick={() => toggleSelected(person.id)}
                >
                  <span className="ft-person-card-check" aria-hidden="true">
                    {selectedIds.has(person.id) ? <CheckSquare size={18} /> : <Square size={18} />}
                  </span>
                  <PersonAvatar person={person} size={64} />
                  <strong>{person.name}</strong>
                  <small>{person.tags.length > 0 ? person.tags.join(" · ") : meta}</small>
                </button>
              ) : (
                <a
                  key={person.id}
                  className="ft-person-card"
                  href={`/family/people/${person.id}`}
                  onClick={(event) => followRoute(event, `/family/people/${person.id}`)}
                >
                  <PersonAvatar person={person} size={64} />
                  <strong>{person.name}</strong>
                  <small>{meta}</small>
                </a>
              );
            })}
          </div>
        )}
      </section>

      {addOpen && (
        <PersonEditModal
          person={null}
          showTags={isAdmin}
          onClose={() => setAddOpen(false)}
          onSaved={(person) => navigate(`/family/people/${person.id}`)}
        />
      )}

      {tagOpen && (
        <BulkTagPeopleModal
          persons={selectedPersons}
          onClose={() => setTagOpen(false)}
          onSaved={(updated) => {
            const byId = new Map(updated.map((person) => [person.id, person]));
            setPersons((current) => current.map((person) => byId.get(person.id) ?? person));
            setTagOpen(false);
            exitSelection();
            setNotice(t("family:people.tagsUpdatedBody", { count: updated.length }));
          }}
        />
      )}

      {accessOpen && (
        <FamilyTreeSettingsModal
          personCount={persons.length}
          onClose={() => setAccessOpen(false)}
          onChanged={() => window.location.reload()}
        />
      )}
    </DashboardShell>
  );
}
