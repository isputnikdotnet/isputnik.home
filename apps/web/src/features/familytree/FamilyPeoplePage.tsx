import { useEffect, useMemo, useState } from "react";
import { Network, UserRoundPlus } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { followRoute, navigate } from "../../router";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { AudiobookPageHeader } from "../audiobooks/AudiobooksPage";
import { PersonAvatar } from "./PersonAvatar";
import { PersonEditModal } from "./PersonEditModal";
import { lifeYears, type FamilyPerson } from "./types";

// Every family member as a searchable grid — the management/finding surface
// beside the chart. Cards open the profile.
export function FamilyPeoplePage({ user, logout }: { user: PublicUser; logout: () => Promise<void> }) {
  const [persons, setPersons] = useState<FamilyPerson[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const isAdmin = user.role === "admin";

  useEffect(() => {
    api<{ persons: FamilyPerson[] }>("/api/family-tree/persons")
      .then((payload) => setPersons(payload.persons))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load family members"));
  }, []);

  const term = search.trim().toLowerCase();
  const shown = useMemo(
    () =>
      term
        ? persons.filter((p) => p.name.toLowerCase().includes(term) || p.maidenName?.toLowerCase().includes(term))
        : persons,
    [persons, term]
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
                <Button variant="primary" compact onClick={() => setAddOpen(true)}>
                  <UserRoundPlus size={16} aria-hidden="true" />
                  Add person
                </Button>
              )}
            </>
          }
        />

        {error && <MessageBox tone="error" title="Unable to load family members">{error}</MessageBox>}

        {shown.length === 0 ? (
          <p className="management-empty">
            {persons.length === 0
              ? isAdmin
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
                    .join(" · ") || " "}
                </small>
              </a>
            ))}
          </div>
        )}
      </section>

      {addOpen && (
        <PersonEditModal
          person={null}
          onClose={() => setAddOpen(false)}
          onSaved={(person) => navigate(`/family/people/${person.id}`)}
        />
      )}
    </DashboardShell>
  );
}
