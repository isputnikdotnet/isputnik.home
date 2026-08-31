import { useEffect, useMemo, useState } from "react";
import { Tags } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { navigate } from "../../router";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { LibraryPageHeader } from "../../shared/LibraryPageHeader";
import { SectionNav } from "../../shared/SectionNav";
import { familyNavProps } from "./sectionNavItems";
import { BulkTagPeopleModal } from "./BulkTagPeopleModal";
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
  const { t } = useTranslation(["common", "family"]);
  const [persons, setPersons] = useState<FamilyPerson[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  // Admin-only: the family whose members are being tagged in bulk.
  const [tagTarget, setTagTarget] = useState<FamilyGroup | null>(null);
  const [notice, setNotice] = useState("");
  const isAdmin = user.role === "admin";

  useEffect(() => {
    api<{ persons: FamilyPerson[] }>("/api/family-tree/persons")
      .then((payload) => setPersons(payload.persons))
      .catch((err) => setError(err instanceof Error ? err.message : t("family:families.errors.loadPersons")));
  }, [t]);

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
    <DashboardShell active="family" user={user} logout={logout} sideNav={<SectionNav {...familyNavProps("families")} />}>
      <section className="audiobook-main-page">
        <LibraryPageHeader
          title={t("family:families.title")}
          subtitle={`${t("family:common.counts.familyName", { count: shown.length })} · ${t("family:common.counts.person", { count: persons.length })}`}
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder={t("family:families.searchPlaceholder")}
        />

        {error && <MessageBox tone="error" title={t("family:families.errorTitle")}>{error}</MessageBox>}
        {notice && <MessageBox tone="success" title={t("family:people.tagsUpdatedTitle")}>{notice}</MessageBox>}

        {shown.length === 0 ? (
          <p className="management-empty">
            {families.length === 0
              ? t("family:families.emptyNoFamilies")
              : t("family:families.emptyNoMatches")}
          </p>
        ) : (
          <div className="ft-family-name-grid">
            {shown.map((family) => (
              <div className="ft-family-name-slot" key={family.surname}>
                <button
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
                    {t("family:common.counts.person", { count: family.members.length })}
                    {family.span && ` · ${family.span}`}
                  </small>
                  <small className="ft-family-name-anchor">
                    {t("family:families.opensOn", { name: family.anchor.name })}
                    {lifeYears(family.anchor) && ` (${lifeYears(family.anchor)})`}
                  </small>
                </button>
                {/* Tagging a whole family is the reason this page is a useful
                    starting point for branch access: the surname group is the
                    seed, and the modal grows it along the tree from there. */}
                {isAdmin && (
                  <Button
                    variant="icon"
                    className="ft-family-name-tag"
                    aria-label={t("family:families.tagFamily", { name: family.surname })}
                    title={t("family:families.tagFamily", { name: family.surname })}
                    onClick={() => setTagTarget(family)}
                  >
                    <Tags size={16} aria-hidden="true" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {tagTarget && (
        <BulkTagPeopleModal
          persons={tagTarget.members}
          onClose={() => setTagTarget(null)}
          onSaved={(updated) => {
            const byId = new Map(updated.map((person) => [person.id, person]));
            setPersons((current) => current.map((person) => byId.get(person.id) ?? person));
            setTagTarget(null);
            setNotice(t("family:people.tagsUpdatedBody", { count: updated.length }));
          }}
        />
      )}
    </DashboardShell>
  );
}
