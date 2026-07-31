import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, UsersRound } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { followRoute, navigate } from "../../router";
import { MessageBox } from "../../shared/MessageBox";
import { AudiobookPageHeader } from "../audiobooks/AudiobooksPage";
import { PersonAvatar } from "./PersonAvatar";
import { lifeYears, type FamilyPerson } from "./types";

interface FamilyGroup {
  surname: string;
  members: FamilyPerson[];
  /** Who the chart opens on for this family — the earliest-born member. */
  anchor: FamilyPerson;
  span: string;
}

// The surname is the last word of the display name; single-word names are
// their own family. Maiden names are not folded in — a person belongs to the
// family they are listed under, which is what the chart labels them with.
function surnameOf(person: FamilyPerson): string {
  const parts = person.name.trim().split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1] : parts[0] ?? "";
}

function birthYear(person: FamilyPerson): number {
  const year = Number(person.birthDate?.slice(0, 4));
  return Number.isFinite(year) ? year : Number.POSITIVE_INFINITY;
}

// One card per family name, so the tree can be entered by branch instead of by
// person. Choosing a family focuses the chart on that family's oldest member —
// from there the usual pan/click navigation takes over.
export function FamilyFamiliesPage({ user, logout }: { user: PublicUser; logout: () => Promise<void> }) {
  const [persons, setPersons] = useState<FamilyPerson[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ persons: FamilyPerson[] }>("/api/family-tree/persons")
      .then((payload) => setPersons(payload.persons))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load family members"));
  }, []);

  const families = useMemo<FamilyGroup[]>(() => {
    const bySurname = new Map<string, FamilyPerson[]>();
    for (const person of persons) {
      const surname = surnameOf(person);
      if (!surname) continue;
      const bucket = bySurname.get(surname);
      if (bucket) bucket.push(person);
      else bySurname.set(surname, [person]);
    }
    return [...bySurname.entries()]
      .map(([surname, members]) => {
        const sorted = [...members].sort((a, b) => birthYear(a) - birthYear(b) || a.name.localeCompare(b.name));
        const years = members.map(birthYear).filter((year) => Number.isFinite(year));
        const earliest = years.length ? Math.min(...years) : null;
        const latest = years.length ? Math.max(...years) : null;
        return {
          surname,
          members: sorted,
          anchor: sorted[0],
          span: earliest == null ? "" : earliest === latest ? `${earliest}` : `${earliest}–${latest}`
        };
      })
      .sort((a, b) => b.members.length - a.members.length || a.surname.localeCompare(b.surname));
  }, [persons]);

  const term = search.trim().toLowerCase();
  const shown = term ? families.filter((family) => family.surname.toLowerCase().includes(term)) : families;

  return (
    <DashboardShell active="family" user={user} logout={logout}>
      <section className="audiobook-main-page">
        <a className="audiobook-back-button" href="/family" onClick={(event) => followRoute(event, "/family")}>
          <ArrowLeft size={18} aria-hidden="true" />
          <span>Back to the tree</span>
        </a>

        <AudiobookPageHeader
          title="Families"
          subtitle={`${families.length} ${families.length === 1 ? "family name" : "family names"} · ${persons.length} ${persons.length === 1 ? "person" : "people"}`}
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search family names..."
          actions={
            <a className="secondary-button compact-button" href="/family/people" onClick={(event) => followRoute(event, "/family/people")}>
              <UsersRound size={16} aria-hidden="true" />
              All people
            </a>
          }
        />

        {error && <MessageBox tone="error" title="Unable to load families">{error}</MessageBox>}

        {shown.length === 0 ? (
          <p className="management-empty">
            {families.length === 0
              ? "No family members yet — once people are added, their family names appear here."
              : "No family name matches your search."}
          </p>
        ) : (
          <div className="ft-family-name-grid">
            {shown.map((family) => (
              <button
                key={family.surname}
                type="button"
                className="ft-family-name-card"
                onClick={() => navigate(`/family/tree/${family.anchor.id}`)}
              >
                <span className="ft-family-name-faces" aria-hidden="true">
                  {family.members.slice(0, 4).map((person) => (
                    <PersonAvatar key={person.id} person={person} size={38} />
                  ))}
                </span>
                <strong>{family.surname}</strong>
                <small>
                  {family.members.length} {family.members.length === 1 ? "person" : "people"}
                  {family.span && ` · ${family.span}`}
                </small>
                <small className="ft-family-name-anchor">
                  Opens on {family.anchor.name}
                  {lifeYears(family.anchor) && ` (${lifeYears(family.anchor)})`}
                </small>
              </button>
            ))}
          </div>
        )}
      </section>
    </DashboardShell>
  );
}
