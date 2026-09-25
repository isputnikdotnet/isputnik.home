import { Fragment, type CSSProperties, type ReactNode } from "react";
import { HeartCrack, Pencil, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import { followRoute } from "../../router";
import { Button } from "../../shared/Button";
import { formatPartialDate } from "../../shared/utils";
import { PersonAvatar } from "./PersonAvatar";
import {
  childRelationLabel, lifeYears, unionStatusLabel,
  type FamilyPerson, type FamilyPersonProfile, type FamilyTree, type FamilyUnionDetail
} from "./types";

// A person's Relationships tab, drawn as a family tree rather than as lists.
//
// Five category lists (Parents, Siblings, Grandparents, Partners, Children) say
// who is related but not HOW — which grandparents are whose side, which children
// came from which partnership. So the same people are placed where a family tree
// puts them: each parent under their own parents, the couple joined by a line
// that comes down to this person, siblings to one side, partners to the other
// (the current one joined by a solid line, a former one by a dashed line), and
// the children hanging off a rail below.
//
// Every action the old lists carried is still on the cards — edit a
// relationship, remove a union or a child link — and a generation with nobody in
// it is simply not drawn. Below about 760px of width the drawing gives way to a
// single column in the same order, since lines between cards that no longer sit
// side by side would connect nothing.

type RelationPerson = Pick<FamilyPerson, "id" | "name" | "gender" | "birthDate" | "deathDate" | "portraitUrl">;

function uniquePeople(people: RelationPerson[]): RelationPerson[] {
  const seen = new Set<string>();
  return people.filter((person) => {
    if (seen.has(person.id)) return false;
    seen.add(person.id);
    return true;
  });
}

/** Grandparents, still attached to the parent they came through. */
interface GrandparentGroup {
  parent: RelationPerson;
  people: RelationPerson[];
}

/** A step-parent or half-sibling, and the parent they come through. */
interface StepRelation {
  person: RelationPerson;
  via: RelationPerson;
}

export function extendedFamily(profile: FamilyPersonProfile, tree: FamilyTree | null) {
  if (!tree) {
    return {
      siblings: [] as RelationPerson[],
      grandparentGroups: [] as GrandparentGroup[],
      stepParents: [] as StepRelation[],
      halfSiblings: [] as StepRelation[]
    };
  }
  const personById = new Map(tree.persons.map((person) => [person.id, person]));
  const unionById = new Map(tree.unions.map((union) => [union.id, union]));
  const parentUnionId = tree.children.find((link) => link.childId === profile.id)?.unionId;
  const siblings = parentUnionId
    ? tree.children
        .filter((link) => link.unionId === parentUnionId && link.childId !== profile.id)
        .map((link) => personById.get(link.childId))
        .filter((person): person is FamilyPerson => person != null)
    : [];
  // Grouped by the parent they came through, not flattened into one row: two
  // pairs, each over the parent they belong to, say which side of the family each
  // one is — the question anybody actually has when they look.
  const grandparentGroups = profile.parents.flatMap((parent) => {
    const parentParentUnionId = tree.children.find((link) => link.childId === parent.id)?.unionId;
    const union = parentParentUnionId ? unionById.get(parentParentUnionId) : undefined;
    if (!union) return [];
    const people = uniquePeople(
      [union.person1Id, union.person2Id]
        .map((personId) => (personId ? personById.get(personId) : null))
        .filter((person): person is FamilyPerson => person != null)
        // A tree can record somebody as a partner in the very union they are a
        // child of; refusing that keeps a parent out of their own parents. A
        // grandparent who merely SHARES a parent's name is a different person
        // and still shows, told apart by their dates.
        .filter((person) => person.id !== parent.id)
    );
    return people.length > 0 ? [{ parent, people }] : [];
  });
  // A parent's other partnerships: the partner is a step-parent, their children
  // together are half-siblings — through that parent, which each card says.
  const stepParents: StepRelation[] = [];
  const halfSiblings: StepRelation[] = [];
  const siblingIds = new Set([profile.id, ...siblings.map((sibling) => sibling.id)]);
  for (const parent of profile.parents) {
    for (const union of tree.unions) {
      if (union.id === parentUnionId) continue;
      if (union.person1Id !== parent.id && union.person2Id !== parent.id) continue;
      const partnerId = union.person1Id === parent.id ? union.person2Id : union.person1Id;
      const partner = partnerId ? personById.get(partnerId) : undefined;
      if (partner && partner.id !== profile.id) stepParents.push({ person: partner, via: parent });
      for (const link of tree.children) {
        if (link.unionId !== union.id || siblingIds.has(link.childId)) continue;
        const child = personById.get(link.childId);
        if (child) halfSiblings.push({ person: child, via: parent });
      }
    }
  }
  const onceEach = (list: StepRelation[]) => {
    const seen = new Set<string>();
    return list.filter(({ person }) => !seen.has(person.id) && seen.add(person.id));
  };
  // Oldest first, like siblings everywhere else; unknown dates last.
  const byBirth = (a: StepRelation, b: StepRelation) => (a.person.birthDate ?? "9999").localeCompare(b.person.birthDate ?? "9999");
  return {
    siblings: uniquePeople(siblings),
    grandparentGroups,
    stepParents: onceEach(stepParents),
    halfSiblings: onceEach(halfSiblings).sort(byBirth)
  };
}

// What this person is TO the person whose page this is. Gendered where the record
// says so, neutral where it doesn't: an unknown gender gets "Parent", never a guess.
type RelationKind = "parent" | "sibling" | "halfSibling" | "stepParent" | "grandparent" | "child" | "partner" | "formerPartner";

function relationWord(kind: RelationKind, person: Pick<FamilyPerson, "gender">): string {
  const genderKey = person.gender === "male" || person.gender === "female" ? person.gender : "neutral";
  return i18n.t(`family:relationWord.${kind}.${genderKey}`);
}

// "since 2010", "2010 – 2015", "until 2015" — the union's span for card detail.
// A marriage that ended with a death ends on that death: "Widowed · since 1910"
// read as widowed since 1910, when 1910 was the wedding and 1919 the loss.
function unionDates(union: FamilyUnionDetail, self: Pick<FamilyPerson, "deathDate">): string {
  const married = union.marriedDate ? formatPartialDate(union.marriedDate) : "";
  const divorced = union.divorcedDate ? formatPartialDate(union.divorcedDate) : "";
  if (married && divorced) return i18n.t("family:person.unionDates.range", { start: married, end: divorced });
  if (union.status === "widowed") {
    // Whichever of the two died first is when the marriage ended.
    const deaths = [self.deathDate, union.partner?.deathDate].filter((date): date is string => Boolean(date)).sort();
    const ended = deaths[0] ? formatPartialDate(deaths[0]) : "";
    if (married && ended) return i18n.t("family:person.unionDates.range", { start: married, end: ended });
    if (married) return i18n.t("family:person.unionDates.married", { date: married });
    if (ended) return i18n.t("family:person.unionDates.until", { date: ended });
    return "";
  }
  if (married) return i18n.t("family:person.unionDates.since", { date: married });
  if (divorced) return i18n.t("family:person.unionDates.until", { date: divorced });
  return "";
}

// "Wife" for a marriage, "Former wife" once it was dissolved, "Partner" for the
// rest. A marriage ended by death was a marriage still: she was his wife.
function partnerWord(union: FamilyUnionDetail, person: Pick<FamilyPerson, "gender">): string {
  if (union.status === "married" || union.status === "widowed") return relationWord("partner", person);
  if (union.status === "divorced" || union.divorcedDate) return relationWord("formerPartner", person);
  return i18n.t("family:relationWord.partner.neutral");
}

/** Two linked rings: a couple that is together now. Lucide has no such glyph. */
function RingsIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="9" cy="12" r="5.5" />
      <circle cx="15" cy="12" r="5.5" />
    </svg>
  );
}

function RelationCard({
  person,
  badge,
  dates,
  note,
  noteTone,
  icon,
  action,
  self = false
}: {
  person: RelationPerson;
  /** "Father", "Sister" — what they are to the person whose page this is. */
  badge: string;
  /** Replaces the life years (a relation other than biological, say). */
  dates?: string;
  /** A third line: a partnership's status and span, which parent a child is with. */
  note?: string;
  noteTone?: "current" | "former";
  icon?: ReactNode;
  action?: ReactNode;
  /** The person whose page this is: not a link, and marked. */
  self?: boolean;
}) {
  const { t } = useTranslation(["family"]);
  const body = (
    <>
      <PersonAvatar person={person} size={self ? 56 : 42} />
      <span className="ft-relation-card-copy">
        {/* Long names are cut to one line in a narrow card; hovering shows all of it. */}
        <strong title={person.name}>{person.name}</strong>
        <span className="ft-relation-card-meta">
          <span className="ft-relation-badge">{badge}</span>
          <small>{dates || lifeYears(person) || t("family:common.lifeDatesUnknown")}</small>
        </span>
        {note && <small className={`ft-relation-card-note${noteTone ? ` is-${noteTone}` : ""}`}>{note}</small>}
      </span>
      {icon && <span className={`ft-relation-card-icon${noteTone ? ` is-${noteTone}` : ""}`}>{icon}</span>}
    </>
  );
  return (
    <span className={`ft-relation-card-wrap${self ? " is-self" : ""}`}>
      {self ? (
        <span className="ft-relation-card is-self" aria-current="page">{body}</span>
      ) : (
        <a
          className="ft-relation-card"
          href={`/family/people/${person.id}`}
          onClick={(event) => followRoute(event, `/family/people/${person.id}`)}
        >
          {body}
        </a>
      )}
      {action}
    </span>
  );
}

function SectionLabel({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return <h3 className={["ft-rtree-label", className].filter(Boolean).join(" ")} style={style}>{children}</h3>;
}

export function RelationshipTree({
  profile,
  tree,
  current,
  canEdit,
  isAdmin,
  onEditUnion,
  onRemoveUnion,
  onRemoveChild
}: {
  profile: FamilyPersonProfile;
  tree: FamilyTree | null;
  /** The undissolved partnership, which the page also names in its header. */
  current: FamilyUnionDetail | null;
  canEdit: boolean;
  isAdmin: boolean;
  onEditUnion: (union: FamilyUnionDetail) => void;
  onRemoveUnion: (unionId: string) => void;
  onRemoveChild: (unionId: string, childId: string) => void;
}) {
  const { t } = useTranslation(["common", "family"]);
  const family = extendedFamily(profile, tree);
  // Current partner first; former partnerships follow.
  const partners = profile.unions
    .filter((union) => union.partner)
    .sort((a, b) => Number(b.id === current?.id) - Number(a.id === current?.id));
  const children = profile.unions.flatMap((union) => union.children.map((child) => ({ union, child })));
  // With children from more than one partnership, each child says which.
  const childUnions = new Set(children.map(({ union }) => union.id));
  const parents = profile.parents;
  const hasSiblings = family.siblings.length > 0 || family.halfSiblings.length > 0;
  const hasPartners = partners.length > 0;

  if (family.grandparentGroups.length === 0 && parents.length === 0 && family.stepParents.length === 0 && !hasSiblings && !hasPartners && children.length === 0) {
    return (
      <p className="ft-relation-empty">
        {t("family:person.relationships.emptyBase")}{canEdit ? t("family:person.relationships.emptyHint") : ""}
      </p>
    );
  }

  const groupOf = (parentId: string) => family.grandparentGroups.find((group) => group.parent.id === parentId) ?? null;
  const parentNote = profile.parentRelation && profile.parentRelation !== "biological" ? childRelationLabel(profile.parentRelation) : undefined;
  const hasGrandparents = family.grandparentGroups.length > 0;

  return (
    <div className="ft-rtree">
      {parents.length > 0 && (
        <div
          className={`ft-rtree-ancestors${parents.length === 1 ? " is-single" : ""}${hasGrandparents ? " has-grandparents" : ""}`}
          style={{ "--ft-rtree-cols": parents.length } as CSSProperties}
        >
          {hasGrandparents && (
            <SectionLabel className="is-grandparents">{t("family:person.relationships.grandparents")}</SectionLabel>
          )}
          {parents.map((parent, index) => {
            const group = groupOf(parent.id);
            const column = index + 1;
            return (
              <Fragment key={parent.id}>
                {group && (
                  <>
                    <div className="ft-rtree-branch" style={{ gridColumn: column, gridRow: 2 }}>
                      <span className="ft-rtree-branch-label">{t("family:person.relationships.viaParent", { name: group.parent.name })}</span>
                      <div className="ft-rtree-branch-cards">
                        {group.people.map((grandparent) => (
                          <RelationCard key={grandparent.id} person={grandparent} badge={relationWord("grandparent", grandparent)} />
                        ))}
                      </div>
                    </div>
                    <span className="ft-rtree-stem is-branch" style={{ gridColumn: column, gridRow: 3 }} aria-hidden="true" />
                  </>
                )}
                <div className="ft-rtree-parent" style={{ gridColumn: column, gridRow: 4 }}>
                  <RelationCard person={parent} badge={relationWord("parent", parent)} dates={parentNote && `${lifeYears(parent) ? `${lifeYears(parent)} · ` : ""}${parentNote}`} />
                </div>
              </Fragment>
            );
          })}
          <SectionLabel className="is-parents" style={{ gridRow: 3 }}>{t("family:person.relationships.parents")}</SectionLabel>
          {parents.length === 2 && <span className="ft-rtree-couple-line" style={{ gridRow: 4 }} aria-hidden="true" />}
          <span className="ft-rtree-stem is-down" aria-hidden="true" />
        </div>
      )}

      {family.stepParents.length > 0 && (
        <div className="ft-rtree-stepparents">
          <SectionLabel>{t("family:person.relationships.stepParents")}</SectionLabel>
          <div className="ft-rtree-stepparent-cards">
            {family.stepParents.map(({ person, via }) => (
              <RelationCard
                key={person.id}
                person={person}
                badge={relationWord("stepParent", person)}
                note={t("family:person.relationships.partnerOf", { name: via.name })}
              />
            ))}
          </div>
        </div>
      )}

      <div className={`ft-rtree-family ft-tree-self-row${hasSiblings ? " has-siblings" : ""}${hasPartners ? " has-partners" : ""}`}>
        <div className="ft-rtree-side is-siblings">
          {hasSiblings && (
            <>
              <SectionLabel>{t("family:person.relationships.siblings")}</SectionLabel>
              {/* One to a row, each row drawing its own tick and its own piece of
                  the bracket, so the bracket reaches exactly the siblings there
                  are. (Pairs, as a wide mockup had them, never fit: this tab is at
                  most about 1,150px wide, and pairs crowded this person's card.) */}
              <div className="ft-rtree-siblings">
                {family.siblings.map((sibling) => (
                  <div className="ft-rtree-sibling-row" key={sibling.id}>
                    <RelationCard person={sibling} badge={relationWord("sibling", sibling)} />
                  </div>
                ))}
                {/* Half-siblings after the full ones, each saying which parent they share. */}
                {family.halfSiblings.map(({ person, via }) => (
                  <div className="ft-rtree-sibling-row" key={person.id}>
                    <RelationCard
                      person={person}
                      badge={relationWord("halfSibling", person)}
                      note={t("family:person.relationships.viaParent", { name: via.name })}
                    />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="ft-rtree-self">
          <SectionLabel>{t("family:person.relationships.family")}</SectionLabel>
          <RelationCard self person={profile} badge={t("family:person.relationships.thisPerson")} />
        </div>

        <div className="ft-rtree-side is-partners">
          {hasPartners && (
            <>
              <SectionLabel>{t("family:person.relationships.partners")}</SectionLabel>
              <div className="ft-rtree-partners">
                {partners.map((union) => {
                  const person = union.partner!;
                  const isCurrent = union.id === current?.id;
                  const former = !isCurrent && (union.status === "divorced" || union.status === "widowed" || Boolean(union.divorcedDate));
                  return (
                    <div key={union.id} className={`ft-rtree-partner${isCurrent ? " is-current" : ""}${former ? " is-former" : ""}`}>
                      <RelationCard
                        person={person}
                        badge={partnerWord(union, person)}
                        note={[
                          isCurrent ? t("family:person.relationships.current") : "",
                          unionStatusLabel(union.status),
                          unionDates(union, profile)
                        ].filter(Boolean).join(" · ")}
                        noteTone={isCurrent ? "current" : former ? "former" : undefined}
                        icon={isCurrent ? <RingsIcon /> : former ? <HeartCrack size={20} aria-hidden="true" /> : undefined}
                        action={canEdit && (
                          <span className="ft-relation-card-actions">
                            <Button
                              variant="icon"
                              title={t("family:person.relationships.editRelationshipAria", { name: person.name })}
                              aria-label={t("family:person.relationships.editRelationshipAria", { name: person.name })}
                              onClick={() => onEditUnion(union)}
                            >
                              <Pencil size={13} aria-hidden="true" />
                            </Button>
                            {isAdmin && (
                              <Button
                                variant="icon"
                                danger
                                title={t("family:person.relationships.removeUnionAria")}
                                aria-label={t("family:person.relationships.removeUnionAria")}
                                onClick={() => onRemoveUnion(union.id)}
                              >
                                <X size={14} aria-hidden="true" />
                              </Button>
                            )}
                          </span>
                        )}
                      />
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {children.length > 0 && (
        <div className="ft-rtree-descendants">
          <span className="ft-rtree-stem is-down" aria-hidden="true" />
          <SectionLabel>{t("family:person.relationships.children")}</SectionLabel>
          <div className={`ft-rtree-children${children.length === 1 ? " is-single" : ""}`}>
            {children.map(({ union, child }) => {
              const withPartner = childUnions.size > 1
                ? union.partner
                  ? t("family:person.relationships.withPartner", { name: union.partner.name })
                  : t("family:person.relationships.withNoPartner")
                : undefined;
              return (
                <div className="ft-rtree-child" key={`${union.id}-${child.id}`}>
                  <RelationCard
                    person={child}
                    badge={relationWord("child", child)}
                    dates={child.relation !== "biological"
                      ? [lifeYears(child), childRelationLabel(child.relation)].filter(Boolean).join(" · ")
                      : undefined}
                    note={withPartner}
                    action={isAdmin && (
                      <span className="ft-relation-card-actions">
                        <Button
                          variant="icon"
                          danger
                          title={t("family:person.relationships.removeChildAria", { name: child.name })}
                          aria-label={t("family:person.relationships.removeChildAria", { name: child.name })}
                          onClick={() => onRemoveChild(union.id, child.id)}
                        >
                          <X size={14} aria-hidden="true" />
                        </Button>
                      </span>
                    )}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
