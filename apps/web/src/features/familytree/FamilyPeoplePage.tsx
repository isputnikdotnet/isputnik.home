import { useEffect, useMemo, useState } from "react";
import { Network, ShieldCheck, UserRoundPlus } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { followRoute, navigate } from "../../router";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { AudiobookPageHeader } from "../audiobooks/AudiobooksPage";
import { FamilyTagAccessModal } from "./FamilyTagAccessModal";
import { PersonAvatar } from "./PersonAvatar";
import { PersonEditModal } from "./PersonEditModal";
import { lifeYears, type FamilyPerson, type FamilyTreeAccess } from "./types";

// Every family member as a searchable grid — the management/finding surface
// beside the chart. Cards open the profile. Tags (family branches) act as a
// filter here and, for admins, as the edit-permission scope (Branch access).
export function FamilyPeoplePage({ user, logout }: { user: PublicUser; logout: () => Promise<void> }) {
  const [persons, setPersons] = useState<FamilyPerson[]>([]);
  const [access, setAccess] = useState<FamilyTreeAccess | null>(null);
  const [search, setSearch] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const isAdmin = user.role === "admin";

  useEffect(() => {
    api<{ persons: FamilyPerson[]; access: FamilyTreeAccess }>("/api/family-tree/persons")
      .then((payload) => { setPersons(payload.persons); setAccess(payload.access); })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load family members"));
  }, []);

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

  return (
    <DashboardShell active="family" user={user} logout={logout}>
      <section className="audiobook-main-page">
        <AudiobookPageHeader
          title="Family members"
          subtitle={`${persons.length} ${persons.length === 1 ? "person" : "people"}`}
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search family members..."
          actions={
            <>
              <a className="secondary-button compact-button" href="/family" onClick={(event) => followRoute(event, "/family")}>
                <Network size={16} aria-hidden="true" />
                Tree view
              </a>
              {isAdmin && (
                <Button variant="secondary" compact onClick={() => setAccessOpen(true)}>
                  <ShieldCheck size={16} aria-hidden="true" />
                  Branch access
                </Button>
              )}
              {access?.canAdd && (
                <Button variant="primary" compact onClick={() => setAddOpen(true)}>
                  <UserRoundPlus size={16} aria-hidden="true" />
                  Add person
                </Button>
              )}
            </>
          }
        />

        {error && <MessageBox tone="error" title="Unable to load family members">{error}</MessageBox>}

        {tagCounts.length > 0 && (
          <div className="ft-tag-filter" role="group" aria-label="Filter by family tag">
            {tagCounts.map(([tag, count]) => (
              <button
                key={tag}
                type="button"
                className={`book-tag-chip book-tag-chip-tag${activeTag === tag ? " ft-tag-chip-active" : ""}`}
                aria-pressed={activeTag === tag}
                onClick={() => setActiveTag(activeTag === tag ? null : tag)}
              >
                {tag} · {count}
              </button>
            ))}
          </div>
        )}

        {shown.length === 0 ? (
          <p className="management-empty">
            {persons.length === 0
              ? access?.canAdd
                ? "No family members yet. Add the first person to start the tree."
                : "No family members yet."
              : "No one matches your search."}
          </p>
        ) : (
          <div className="ft-people-grid">
            {shown.map((person) => (
              <a
                key={person.id}
                className="ft-person-card"
                href={`/family/people/${person.id}`}
                onClick={(event) => followRoute(event, `/family/people/${person.id}`)}
              >
                <PersonAvatar person={person} size={64} />
                <strong>{person.name}</strong>
                <small>
                  {[person.maidenName ? `née ${person.maidenName}` : "", lifeYears(person)]
                    .filter(Boolean)
                    .join(" · ") || " "}
                </small>
              </a>
            ))}
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

      {accessOpen && <FamilyTagAccessModal onClose={() => setAccessOpen(false)} />}
    </DashboardShell>
  );
}
