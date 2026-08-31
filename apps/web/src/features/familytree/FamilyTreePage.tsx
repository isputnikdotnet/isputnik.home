import { useEffect, useMemo, useRef, useState } from "react";
import { FileUp, Search, Settings, UserRoundPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate } from "../../router";
import { Button } from "../../shared/Button";
import { LibraryPageHeader } from "../../shared/LibraryPageHeader";
import { MessageBox } from "../../shared/MessageBox";
import { SectionNav } from "../../shared/SectionNav";
import { familyNavProps } from "./sectionNavItems";
import { AddRelativeModal } from "./AddRelativeModal";
import { defaultFocusId } from "./chart-layout";
import { FamilyTreeChart } from "./FamilyTreeChart";
import { FamilyTreeSettingsModal } from "./FamilyTreeSettingsModal";
import { GedcomImportModal } from "./GedcomImportModal";
import { FamilyPersonMark, PersonAvatar } from "./PersonAvatar";
import { PersonEditModal } from "./PersonEditModal";
import { lifeYears, type FamilyPerson, type FamilyTree } from "./types";

// The main family-tree view: a person-centered pan/zoom chart. Clicking a card
// re-centers on that person via a real navigation (/family/tree/:id) so the
// browser's back button walks the focus history.
export function FamilyTreePage({
  user,
  logout,
  focusId
}: {
  user: PublicUser;
  logout: () => Promise<void>;
  focusId: string | null;
}) {
  const { t } = useTranslation(["common", "family"]);
  const isAdmin = user.role === "admin";
  const [tree, setTree] = useState<FamilyTree | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editPerson, setEditPerson] = useState<FamilyPerson | null>(null);
  const [addRelativeTo, setAddRelativeTo] = useState<FamilyPerson | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);

  const loadTree = () => {
    api<FamilyTree>("/api/family-tree/tree")
      .then(setTree)
      .catch((err) => setError(err instanceof Error ? err.message : t("family:tree.errorTitle")));
  };
  useEffect(loadTree, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!searchOpen) return;
    const close = (event: PointerEvent) => {
      if (!searchRef.current?.contains(event.target as Node)) setSearchOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [searchOpen]);

  // The URL wins (that's how clicking a card and the back button work), then the
  // starting person an admin chose, then the chart's own guess. Each step checks
  // the person is really in the tree, so a stale id falls through instead of
  // leaving the chart with nothing to centre on.
  const activeFocusId = useMemo(() => {
    if (!tree) return null;
    const inTree = (id: string | null) => Boolean(id && tree.persons.some((p) => p.id === id));
    if (inTree(focusId)) return focusId;
    if (inTree(tree.defaultPersonId)) return tree.defaultPersonId;
    return defaultFocusId(tree);
  }, [tree, focusId]);

  const term = search.trim().toLowerCase();
  const matches = term && tree
    ? tree.persons
        .filter((p) => p.name.toLowerCase().includes(term) || p.maidenName?.toLowerCase().includes(term))
        .slice(0, 8)
    : [];

  const jumpTo = (person: FamilyPerson) => {
    setSearch("");
    setSearchOpen(false);
    navigate(`/family/tree/${person.id}`);
  };
  const canAdd = tree?.access.canAdd ?? false;

  return (
    <DashboardShell active="family" user={user} logout={logout} sideNav={<SectionNav {...familyNavProps("chart")} />}>
      <section className="ft-tree-page">
        {/* The standard page header, with the section's own search passed through
            the actions slot rather than the search one: on the chart, finding
            someone means re-centring the tree on them, not narrowing a grid, so
            it is a typeahead with a results dropdown hanging off it.

            Add person and Settings show here only while the tree is empty. Once
            there is a chart they live on ITS toolbar, beside Home, Import and
            Export — offering them in both places would be two of each. */}
        <LibraryPageHeader
          title={t("nav.familyTree")}
          subtitle={tree && tree.persons.length > 0
            ? t("family:common.counts.person", { count: tree.persons.length })
            : undefined}
          actions={
            <>
              <div className="ft-tree-search" ref={searchRef}>
                <label className="ft-picker-search">
                  <Search size={17} aria-hidden="true" />
                  <span className="sr-only">{t("family:tree.findPersonSr")}</span>
                  <input
                    type="search"
                    value={search}
                    placeholder={t("family:tree.findPersonPlaceholder")}
                    onChange={(event) => { setSearch(event.target.value); setSearchOpen(true); }}
                    onFocus={() => setSearchOpen(true)}
                  />
                </label>
                {searchOpen && matches.length > 0 && (
                  <div className="ft-tree-search-results">
                    {matches.map((person) => (
                      <button key={person.id} type="button" className="ft-picker-row" onClick={() => jumpTo(person)}>
                        <PersonAvatar person={person} size={30} />
                        <span className="ft-picker-row-name">
                          <strong>{person.name}</strong>
                          {lifeYears(person) && <small>{lifeYears(person)}</small>}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {isAdmin && tree && tree.persons.length === 0 && (
                <Button
                  variant="icon"
                  className="audiobook-page-action-icon"
                  aria-label={t("family:treeSettings.title")}
                  title={t("family:treeSettings.title")}
                  onClick={() => setSettingsOpen(true)}
                >
                  <Settings size={18} aria-hidden="true" />
                </Button>
              )}
            </>
          }
          primaryAction={canAdd && tree && tree.persons.length === 0 && (
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              <UserRoundPlus size={16} aria-hidden="true" />
              <span>{t("family:common.addPerson")}</span>
            </Button>
          )}
        />

        {error && <MessageBox tone="error" title={t("family:tree.errorTitle")}>{error}</MessageBox>}

        {tree && tree.persons.length === 0 && !error && (
          <div className="ft-tree-empty">
            <div className="ft-tree-empty-branches" aria-hidden="true">
              <span className="ft-tree-empty-line is-left" />
              <span className="ft-tree-empty-line is-right" />
              <span className="ft-tree-empty-line is-down-left" />
              <span className="ft-tree-empty-line is-down-right" />
              <span className="ft-tree-empty-node is-top-left" />
              <span className="ft-tree-empty-node is-top-right" />
              <span className="ft-tree-empty-node is-bottom-left" />
              <span className="ft-tree-empty-node is-bottom-right" />
            </div>
            <div className="ft-tree-empty-content">
              <span className="ft-tree-empty-mark" aria-hidden="true">
                <FamilyPersonMark />
              </span>
              <h2>{t("family:tree.emptyTitle")}</h2>
              <p>
                {tree.access.canAdd
                  ? t("family:tree.emptyBodyCanAdd")
                  : t("family:tree.emptyBodyCannotAdd")}
              </p>
              {tree.access.canAdd && (
                <div className="ft-tree-empty-actions">
                  <Button variant="primary" onClick={() => setAddOpen(true)}>
                    <UserRoundPlus size={16} aria-hidden="true" />
                    {t("family:common.addPerson")}
                  </Button>
                  {isAdmin && (
                    <Button variant="secondary" onClick={() => setImportOpen(true)}>
                      <FileUp size={16} aria-hidden="true" />
                      {t("family:treeSettings.importButton")}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {tree && activeFocusId && tree.persons.length > 0 && (
          <FamilyTreeChart
            tree={tree}
            focusId={activeFocusId}
            onFocus={(personId) => { if (personId !== activeFocusId) navigate(`/family/tree/${personId}`); }}
            onOpenProfile={(personId) => navigate(`/family/people/${personId}?from=/family/tree/${activeFocusId}`)}
            onEditPerson={setEditPerson}
            onAddRelative={setAddRelativeTo}
            // "Home" drops the focus from the URL, so the chart falls back to
            // the starting person the same way a fresh visit does.
            onHome={() => { if (focusId) navigate("/family"); }}
            onAddPerson={tree.access.canAdd ? () => setAddOpen(true) : undefined}
            onImport={isAdmin ? () => setImportOpen(true) : undefined}
            onExport={() => window.location.assign("/api/family-tree/export")}
            onSettings={isAdmin ? () => setSettingsOpen(true) : undefined}
          />
        )}
      </section>

      {addOpen && (
        <PersonEditModal
          person={null}
          showTags={isAdmin}
          onClose={() => setAddOpen(false)}
          onSaved={(person) => { setAddOpen(false); loadTree(); navigate(`/family/tree/${person.id}`); }}
        />
      )}

      {editPerson && (
        <PersonEditModal
          person={editPerson}
          showTags={isAdmin}
          onClose={() => setEditPerson(null)}
          onSaved={() => { setEditPerson(null); loadTree(); }}
        />
      )}

      {addRelativeTo && tree && (
        <AddRelativeModal
          person={addRelativeTo}
          tree={tree}
          onClose={() => setAddRelativeTo(null)}
          // The new relative changes the shape of the chart — reload, but stay
          // centred where the user was rather than jumping to the person added.
          onAdded={() => { setAddRelativeTo(null); loadTree(); }}
        />
      )}

      {importOpen && (
        <GedcomImportModal
          personCount={tree?.persons.length ?? 0}
          onClose={() => setImportOpen(false)}
          // An import rewrites the tree wholesale; reload and re-centre.
          onImported={() => { setImportOpen(false); loadTree(); }}
        />
      )}

      {settingsOpen && (
        <FamilyTreeSettingsModal
          personCount={tree?.persons.length ?? 0}
          onClose={() => setSettingsOpen(false)}
          onChanged={loadTree}
        />
      )}
    </DashboardShell>
  );
}
