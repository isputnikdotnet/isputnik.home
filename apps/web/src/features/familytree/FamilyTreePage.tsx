import { useEffect, useMemo, useRef, useState } from "react";
import { Search, UserRound, UserRoundPlus, UsersRound } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { followRoute, navigate } from "../../router";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { defaultFocusId } from "./chart-layout";
import { FamilyTreeChart } from "./FamilyTreeChart";
import { PersonAvatar } from "./PersonAvatar";
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
  const isAdmin = user.role === "admin";
  const [tree, setTree] = useState<FamilyTree | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);

  const loadTree = () => {
    api<FamilyTree>("/api/family-tree/tree")
      .then(setTree)
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load the family tree"));
  };
  useEffect(loadTree, []);

  useEffect(() => {
    if (!searchOpen) return;
    const close = (event: PointerEvent) => {
      if (!searchRef.current?.contains(event.target as Node)) setSearchOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [searchOpen]);

  const activeFocusId = useMemo(() => {
    if (!tree) return null;
    if (focusId && tree.persons.some((p) => p.id === focusId)) return focusId;
    return defaultFocusId(tree);
  }, [tree, focusId]);

  const focusPerson = tree?.persons.find((p) => p.id === activeFocusId) ?? null;

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

  return (
    <DashboardShell active="family" user={user} logout={logout}>
      <section className="ft-tree-page">
        <header className="ft-tree-header">
          <div className="audiobook-page-title">
            <h1>Family Tree</h1>
            {tree && tree.persons.length > 0 && (
              <p>{tree.persons.length} {tree.persons.length === 1 ? "person" : "people"}</p>
            )}
          </div>
          <div className="ft-tree-header-actions">
            <div className="ft-tree-search" ref={searchRef}>
              <label className="ft-picker-search">
                <Search size={17} aria-hidden="true" />
                <span className="sr-only">Find a person</span>
                <input
                  type="search"
                  value={search}
                  placeholder="Find a person…"
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
            <a className="secondary-button compact-button" href="/family/people" onClick={(event) => followRoute(event, "/family/people")}>
              <UsersRound size={16} aria-hidden="true" />
              All people
            </a>
            {isAdmin && (
              <Button variant="primary" compact onClick={() => setAddOpen(true)}>
                <UserRoundPlus size={16} aria-hidden="true" />
                Add person
              </Button>
            )}
          </div>
        </header>

        {error && <MessageBox tone="error" title="Unable to load the tree">{error}</MessageBox>}

        {tree && tree.persons.length === 0 && !error && (
          <div className="ft-tree-empty">
            <UserRound size={40} aria-hidden="true" />
            <h2>No family members yet</h2>
            <p>
              {isAdmin
                ? "Start the tree by adding the first person — then add partners, children, and photos."
                : "The family tree hasn't been started yet."}
            </p>
            {isAdmin && (
              <Button variant="primary" onClick={() => setAddOpen(true)}>
                <UserRoundPlus size={16} aria-hidden="true" />
                Add person
              </Button>
            )}
          </div>
        )}

        {tree && activeFocusId && tree.persons.length > 0 && (
          <FamilyTreeChart
            tree={tree}
            focusId={activeFocusId}
            onFocus={(personId) => { if (personId !== activeFocusId) navigate(`/family/tree/${personId}`); }}
          />
        )}

        {focusPerson && (
          <footer className="ft-tree-focus-card">
            <PersonAvatar person={focusPerson} size={40} />
            <span className="ft-picker-row-name">
              <strong>{focusPerson.name}</strong>
              {lifeYears(focusPerson) && <small>{lifeYears(focusPerson)}</small>}
            </span>
            <a
              className="secondary-button compact-button"
              href={`/family/people/${focusPerson.id}?from=/family/tree/${focusPerson.id}`}
              onClick={(event) => followRoute(event, `/family/people/${focusPerson.id}?from=/family/tree/${focusPerson.id}`)}
            >
              Open profile
            </a>
          </footer>
        )}
      </section>

      {addOpen && (
        <PersonEditModal
          person={null}
          onClose={() => setAddOpen(false)}
          onSaved={(person) => { setAddOpen(false); loadTree(); navigate(`/family/tree/${person.id}`); }}
        />
      )}
    </DashboardShell>
  );
}
