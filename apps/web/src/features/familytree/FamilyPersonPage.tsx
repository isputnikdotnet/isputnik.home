import { Children, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft, Baby, BookMarked, BriefcaseBusiness, CalendarDays, CalendarPlus, Camera, ExternalLink, FileText,
  GraduationCap, Heart, Home as HomeIcon, ImagePlus, Link2, MapPin, Network, Pencil, Plane, Play, Shield,
  Trash2, UserRound, UserRoundPlus, UsersRound, X
} from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { followRoute, getReferrer, navigate } from "../../router";
import { ActionMenu } from "../../shared/ActionMenu";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MessageBox } from "../../shared/MessageBox";
import { AddChildModal } from "./AddChildModal";
import { AddParentModal } from "./AddParentModal";
import { AddSiblingModal } from "./AddSiblingModal";
import { AddUnionModal } from "./AddUnionModal";
import { CitationEditModal } from "./CitationEditModal";
import { EventEditModal } from "./EventEditModal";
import { FamilyPhotoPicker } from "./FamilyPhotoPicker";
import { GalleryPersonLinkModal } from "./GalleryPersonLinkModal";
import { PersonAvatar } from "./PersonAvatar";
import { PersonEditModal } from "./PersonEditModal";
import { UnionEditModal } from "./UnionEditModal";
import {
  lifeYears, EVENT_TYPE_OPTIONS, UNION_STATUS_OPTIONS,
  type FamilyCitation, type FamilyEvent, type FamilyPerson, type FamilyPersonProfile, type FamilyPhoto,
  type FamilyTree, type FamilyUnionDetail
} from "./types";

const PHOTO_PAGE = 40;
const PERSON_DETAIL_TABS = [
  { id: "family", label: "Relationships" },
  { id: "timeline", label: "Timeline" },
  { id: "photos", label: "Photos" },
  { id: "sources", label: "Sources" },
  { id: "notes", label: "Notes" }
] as const;

type PersonDetailTabId = typeof PERSON_DETAIL_TABS[number]["id"];

const eventTypeLabel = (type: FamilyEvent["type"]) =>
  EVENT_TYPE_OPTIONS.find((o) => o.value === type)?.label ?? type;

// One row of the life timeline. Real events carry `event` (editable); birth,
// marriages, and death are synthesized from person/union fields and edited
// through their own modals instead.
interface TimelineEntry {
  key: string;
  sortKey: string;
  dateText: string;
  title: string;
  meta: string[];
  note: string | null;
  tone: "birth" | "union" | "event" | "death";
  event: FamilyEvent | null;
}

function formatPartialDate(date: string | null): string {
  if (!date) return "";
  const [year, month, day] = date.split("-");
  if (!month) return year;
  const monthLabel = new Date(Date.UTC(Number(year), Number(month) - 1, 1))
    .toLocaleString(undefined, { month: "short", timeZone: "UTC" });
  return day ? `${monthLabel} ${Number(day)}, ${year}` : `${monthLabel} ${year}`;
}

function formatDateRange(start: string | null, end: string | null): string {
  return [formatPartialDate(start), formatPartialDate(end)].filter(Boolean).join("–");
}

function timelineEntries(profile: FamilyPersonProfile): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  if (profile.birthDate || profile.birthplace) {
    entries.push({
      key: "birth",
      sortKey: profile.birthDate ?? "0000",
      dateText: formatPartialDate(profile.birthDate),
      title: "Born",
      meta: profile.birthplace ? [profile.birthplace] : [],
      note: null,
      tone: "birth",
      event: null
    });
  }
  for (const union of profile.unions) {
    if (union.partner && (union.marriedDate || union.marriedPlace)) {
      entries.push({
        key: `marr-${union.id}`,
        sortKey: union.marriedDate ?? "9998",
        dateText: formatPartialDate(union.marriedDate),
        title: `Married ${union.partner.name}`,
        meta: union.marriedPlace ? [union.marriedPlace] : [],
        note: null,
        tone: "union",
        event: null
      });
    }
    if (union.partner && union.divorcedDate) {
      entries.push({
        key: `div-${union.id}`,
        sortKey: union.divorcedDate,
        dateText: formatPartialDate(union.divorcedDate),
        title: `Divorced ${union.partner.name}`,
        meta: [],
        note: null,
        tone: "union",
        event: null
      });
    }
    for (const child of union.children) {
      const noun = child.gender === "male" ? "son" : child.gender === "female" ? "daughter" : "child";
      const relationNoun = child.relation === "step"
        ? `step${noun}`
        : child.relation === "adopted" || child.relation === "foster"
          ? `${child.relation} ${noun}`
          : noun;
      entries.push({
        key: `child-${child.id}`,
        sortKey: child.birthDate ?? "9998",
        dateText: formatPartialDate(child.birthDate),
        title: `Birth of ${relationNoun} ${child.name}`,
        meta: child.birthplace ? [child.birthplace] : [],
        note: null,
        tone: "birth",
        event: null
      });
    }
  }
  for (const event of profile.events) {
    entries.push({
      key: event.id,
      sortKey: event.date ?? "9998",
      dateText: formatDateRange(event.date, event.endDate),
      title: event.label || eventTypeLabel(event.type),
      meta: [event.label ? eventTypeLabel(event.type) : "", event.place ?? ""].filter(Boolean),
      note: event.note,
      tone: "event",
      event
    });
  }
  if (profile.deathDate || profile.deathPlace) {
    entries.push({
      key: "death",
      sortKey: profile.deathDate ?? "9999",
      dateText: formatPartialDate(profile.deathDate),
      title: "Died",
      meta: profile.deathPlace ? [profile.deathPlace] : [],
      note: null,
      tone: "death",
      event: null
    });
  }
  return entries.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
}

// "What does this citation support?" — resolved against the profile so the
// Sources section can show "Birth", "Residence (2001)", "Marriage to X".
function citationContext(citation: FamilyCitation, profile: FamilyPersonProfile): string {
  if (citation.eventId) {
    const event = profile.events.find((e) => e.id === citation.eventId);
    if (!event) return "Event";
    const what = event.label || eventTypeLabel(event.type);
    return event.date ? `${what} (${event.date.slice(0, 4)})` : what;
  }
  if (citation.unionId) {
    const union = profile.unions.find((u) => u.id === citation.unionId);
    const partner = union?.partner?.name;
    if (citation.fact === "divorce") return partner ? `Divorce from ${partner}` : "Divorce";
    return partner ? `Marriage to ${partner}` : "Marriage";
  }
  if (citation.fact === "name") return "Name";
  if (citation.fact === "birth") return "Birth";
  if (citation.fact === "death") return "Death";
  return "General";
}

type RelationPerson = Pick<FamilyPerson, "id" | "name" | "gender" | "birthDate" | "deathDate" | "portraitUrl">;

function uniquePeople(people: RelationPerson[]): RelationPerson[] {
  const seen = new Set<string>();
  return people.filter((person) => {
    if (seen.has(person.id)) return false;
    seen.add(person.id);
    return true;
  });
}

function extendedFamily(profile: FamilyPersonProfile, tree: FamilyTree | null) {
  if (!tree) return { siblings: [] as RelationPerson[], grandparents: [] as RelationPerson[] };
  const personById = new Map(tree.persons.map((person) => [person.id, person]));
  const unionById = new Map(tree.unions.map((union) => [union.id, union]));
  const parentUnionId = tree.children.find((link) => link.childId === profile.id)?.unionId;
  const siblings = parentUnionId
    ? tree.children
        .filter((link) => link.unionId === parentUnionId && link.childId !== profile.id)
        .map((link) => personById.get(link.childId))
        .filter((person): person is FamilyPerson => person != null)
    : [];
  const grandparents = profile.parents.flatMap((parent) => {
    const parentParentUnionId = tree.children.find((link) => link.childId === parent.id)?.unionId;
    const union = parentParentUnionId ? unionById.get(parentParentUnionId) : undefined;
    return union
      ? [union.person1Id, union.person2Id].map((personId) => personId ? personById.get(personId) : null)
      : [];
  }).filter((person): person is FamilyPerson => person != null);
  return { siblings: uniquePeople(siblings), grandparents: uniquePeople(grandparents) };
}

function ageFromDates(birthDate: string | null, endDate: string | null): number | null {
  if (!birthDate) return null;
  const partialToDate = (date: string, endOfPeriod: boolean) => {
    const [yearText, monthText, dayText] = date.split("-");
    const year = Number(yearText);
    const month = monthText ? Number(monthText) : endOfPeriod ? 12 : 1;
    const day = dayText ? Number(dayText) : endOfPeriod ? new Date(year, month, 0).getDate() : 1;
    return Number.isFinite(year) ? new Date(year, month - 1, day) : null;
  };
  const birth = partialToDate(birthDate, false);
  const end = endDate ? partialToDate(endDate, true) : new Date();
  if (!birth || !end) return null;
  let age = end.getFullYear() - birth.getFullYear();
  const [, birthMonth, birthDay] = birthDate.split("-").map(Number);
  if (birthMonth && birthDay) {
    const hadBirthday = end.getMonth() + 1 > birthMonth || (end.getMonth() + 1 === birthMonth && end.getDate() >= birthDay);
    if (!hadBirthday) age -= 1;
  }
  return Math.max(0, age);
}

function genderLabel(gender: FamilyPerson["gender"]): string {
  if (gender === "male") return "Male";
  if (gender === "female") return "Female";
  if (gender === "other") return "Other";
  return "Unknown";
}

// The current partner: an undissolved union. Dates win over the status field —
// a marriage with a divorce date recorded is over regardless of what the
// status says. If several qualify, the latest start date wins.
function currentUnion(profile: FamilyPersonProfile): FamilyUnionDetail | null {
  const candidates = profile.unions.filter(
    (u) => u.partner != null && !u.divorcedDate && u.status !== "divorced" && u.status !== "widowed"
  );
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => (b.marriedDate ?? "").localeCompare(a.marriedDate ?? ""))[0];
}

// "since 2010", "2010 – 2015", "until 2015" — the union's span for card detail.
function unionDates(union: FamilyUnionDetail): string {
  const married = union.marriedDate ? formatPartialDate(union.marriedDate) : "";
  const divorced = union.divorcedDate ? formatPartialDate(union.divorcedDate) : "";
  if (married && divorced) return `${married} – ${divorced}`;
  if (married) return `since ${married}`;
  if (divorced) return `until ${divorced}`;
  return "";
}

function relationSummary(profile: FamilyPersonProfile, statusLabel: (status: string) => string) {
  const current = currentUnion(profile);
  if (current?.partner) {
    if (current.status === "married") return `Married to ${current.partner.name}`;
    if (current.status === "partners") return `Together with ${current.partner.name}`;
    return `${statusLabel(current.status)} · ${current.partner.name}`;
  }
  const past = [...profile.unions]
    .filter((item) => item.partner)
    .sort((a, b) => (b.divorcedDate ?? "").localeCompare(a.divorcedDate ?? ""))[0];
  if (!past?.partner) return profile.unions.some((item) => item.children.length > 0) ? "Parent" : "No partner recorded";
  if (past.status === "widowed") return `Widowed from ${past.partner.name}`;
  return `Divorced from ${past.partner.name}`;
}

function TimelineIcon({ entry }: { entry: TimelineEntry }) {
  if (entry.tone === "birth") return <Baby size={16} aria-hidden="true" />;
  if (entry.tone === "union") return <Heart size={16} aria-hidden="true" />;
  if (entry.tone === "death") return <FileText size={16} aria-hidden="true" />;
  if (entry.event?.type === "education") return <GraduationCap size={16} aria-hidden="true" />;
  if (entry.event?.type === "occupation") return <BriefcaseBusiness size={16} aria-hidden="true" />;
  if (entry.event?.type === "residence") return <HomeIcon size={16} aria-hidden="true" />;
  if (entry.event?.type === "military") return <Shield size={16} aria-hidden="true" />;
  if (entry.event?.type === "immigration" || entry.event?.type === "emigration") return <Plane size={16} aria-hidden="true" />;
  if (entry.event?.type === "burial") return <MapPin size={16} aria-hidden="true" />;
  return <CalendarDays size={16} aria-hidden="true" />;
}

function RelationCard({
  person,
  detail,
  action
}: {
  person: RelationPerson;
  detail?: string;
  action?: React.ReactNode;
}) {
  return (
    <span className="ft-relation-card-wrap">
      <a
        className="ft-relation-card"
        href={`/family/people/${person.id}`}
        onClick={(event) => followRoute(event, `/family/people/${person.id}`)}
      >
        <PersonAvatar person={person} size={28} />
        <span className="ft-relation-card-copy">
          <strong>{person.name}</strong>
          <small>{detail || lifeYears(person) || "Life dates unknown"}</small>
        </span>
      </a>
      {action}
    </span>
  );
}

function FamilyGroup({ title, children, empty = "None recorded" }: { title: string; children: React.ReactNode; empty?: string }) {
  const hasChildren = Children.toArray(children).filter(Boolean).length > 0;
  return (
    <div className="ft-family-group">
      <h3>{title}</h3>
      <div className="ft-family-card-grid">
        {hasChildren ? children : <span className="ft-relation-empty">{empty}</span>}
      </div>
    </div>
  );
}

// One family member: profile fields, relationships, and the merged photo wall
// (curated attachments + linked face-cluster photos). Admins edit everything
// here; everyone else gets a read-only view of the same layout.
export function FamilyPersonPage({ id, user, logout }: { id: string; user: PublicUser; logout: () => Promise<void> }) {
  const isAdmin = user.role === "admin";
  const [profile, setProfile] = useState<FamilyPersonProfile | null>(null);
  const [familyTree, setFamilyTree] = useState<FamilyTree | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState("");
  const [photos, setPhotos] = useState<FamilyPhoto[]>([]);
  const [photoTotal, setPhotoTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [unionModal, setUnionModal] = useState(false);
  const [childModal, setChildModal] = useState(false);
  const [parentModal, setParentModal] = useState(false);
  const [siblingModal, setSiblingModal] = useState(false);
  const [editUnion, setEditUnion] = useState<FamilyUnionDetail | null>(null);
  const [photoPicker, setPhotoPicker] = useState(false);
  const [linkModal, setLinkModal] = useState(false);
  // false = closed, null = adding, FamilyEvent = editing.
  const [eventModal, setEventModal] = useState<FamilyEvent | null | false>(false);
  const [removeEvent, setRemoveEvent] = useState<FamilyEvent | null>(null);
  const [citationModal, setCitationModal] = useState<FamilyCitation | null | false>(false);
  const [removeCitation, setRemoveCitation] = useState<FamilyCitation | null>(null);
  const [removeUnionId, setRemoveUnionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [activeDetailTab, setActiveDetailTab] = useState<PersonDetailTabId>("family");
  const portraitFileRef = useRef<HTMLInputElement>(null);

  const loadProfile = useCallback(async () => {
    try {
      const payload = await api<{ person: FamilyPersonProfile }>(`/api/family-tree/persons/${id}`);
      setProfile(payload.person);
      setNotFound(false);
    } catch (err) {
      if ((err as { status?: number }).status === 404) setNotFound(true);
      else setError(err instanceof Error ? err.message : "Unable to load this person");
    }
  }, [id]);

  const loadFamilyTree = useCallback(async () => {
    try {
      setFamilyTree(await api<FamilyTree>("/api/family-tree/tree"));
    } catch {
      setFamilyTree(null);
    }
  }, []);

  const loadPhotos = useCallback(async (offset: number) => {
    const payload = await api<{ assets: FamilyPhoto[]; total: number }>(
      `/api/family-tree/persons/${id}/photos?limit=${PHOTO_PAGE}&offset=${offset}`
    );
    setPhotos((prev) => (offset === 0 ? payload.assets : [...prev, ...payload.assets]));
    setPhotoTotal(payload.total);
  }, [id]);

  useEffect(() => {
    setProfile(null);
    setPhotos([]);
    setError("");
    setActiveDetailTab("family");
    void loadProfile();
    void loadFamilyTree();
    loadPhotos(0).catch(() => {});
  }, [loadProfile, loadFamilyTree, loadPhotos]);

  const refresh = () => {
    void loadProfile();
    void loadFamilyTree();
    loadPhotos(0).catch(() => {});
  };

  const deletePerson = async () => {
    setDeleting(true);
    setDeleteError("");
    try {
      await api(`/api/family-tree/persons/${id}`, { method: "DELETE" });
      navigate("/family/people");
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Unable to delete this person");
      setDeleting(false);
    }
  };

  const removeUnion = async () => {
    if (!removeUnionId) return;
    try {
      await api(`/api/family-tree/unions/${removeUnionId}`, { method: "DELETE" });
      setRemoveUnionId(null);
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to remove the union");
      setRemoveUnionId(null);
    }
  };

  const removeChildLink = async (unionId: string, childId: string) => {
    try {
      await api(`/api/family-tree/unions/${unionId}/children/${childId}`, { method: "DELETE" });
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to remove the child link");
    }
  };

  const deleteEvent = async () => {
    if (!removeEvent) return;
    try {
      await api(`/api/family-tree/events/${removeEvent.id}`, { method: "DELETE" });
      setRemoveEvent(null);
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to delete the event");
      setRemoveEvent(null);
    }
  };

  const deleteCitation = async () => {
    if (!removeCitation) return;
    try {
      await api(`/api/family-tree/citations/${removeCitation.id}`, { method: "DELETE" });
      setRemoveCitation(null);
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to remove the citation");
      setRemoveCitation(null);
    }
  };

  const detachPhoto = async (itemId: string) => {
    try {
      await api(`/api/family-tree/persons/${id}/photos/${itemId}`, { method: "DELETE" });
      setPhotos((prev) => prev.filter((p) => p.id !== itemId));
      setPhotoTotal((prev) => Math.max(0, prev - 1));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to remove the photo");
    }
  };

  const uploadPortrait = async (file: File) => {
    setActionError("");
    try {
      const type = ["image/jpeg", "image/png", "image/webp"].includes(file.type) ? file.type : "image/jpeg";
      await api(`/api/family-tree/persons/${id}/portrait`, {
        method: "PUT",
        headers: { "Content-Type": type },
        body: file
      });
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to upload the portrait");
    }
  };

  const removePortrait = async () => {
    setActionError("");
    try {
      await api(`/api/family-tree/persons/${id}/portrait`, { method: "DELETE" });
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to remove the portrait");
    }
  };

  const back = getReferrer() ?? "/family/people";
  const statusLabel = (status: string) => UNION_STATUS_OPTIONS.find((o) => o.value === status)?.label ?? status;
  // The union this person hangs off as a child — where siblings and the
  // "other parent" attach.
  const parentUnionId = profile && familyTree
    ? familyTree.children.find((link) => link.childId === profile.id)?.unionId ?? null
    : null;
  const siblingIds = profile && familyTree && parentUnionId
    ? familyTree.children.filter((link) => link.unionId === parentUnionId && link.childId !== profile.id).map((link) => link.childId)
    : [];

  if (notFound) {
    return (
      <DashboardShell active="family" user={user} logout={logout}>
        <section className="audiobook-main-page">
          <MessageBox tone="warning" title="Person not found">This family member doesn't exist (anymore).</MessageBox>
          <p><a href="/family/people" onClick={(event) => followRoute(event, "/family/people")}>Back to family members</a></p>
        </section>
      </DashboardShell>
    );
  }

  return (
    <DashboardShell active="family" user={user} logout={logout}>
      <section className="work-area book-detail-area ft-profile-page">
        <div className="book-detail-shell">
          {error && <MessageBox tone="error" title="Unable to load">{error}</MessageBox>}
          {actionError && <MessageBox tone="error" title="Action failed">{actionError}</MessageBox>}

        {profile && (() => {
          const family = extendedFamily(profile, familyTree);
          const entries = timelineEntries(profile);
          const age = ageFromDates(profile.birthDate, profile.deathDate);
          const subtitle = [
            profile.maidenName ? `née ${profile.maidenName}` : "",
            lifeYears(profile),
            profile.deathDate ? "Deceased" : "Living",
            age != null ? `Age ${age}` : ""
          ].filter(Boolean).join(" · ");
          const current = currentUnion(profile);
          // Current partner first; former unions follow.
          const partners = profile.unions
            .map((union) => ({ union, person: union.partner }))
            .filter((item) => item.person)
            .sort((a, b) => Number(b.union.id === current?.id) - Number(a.union.id === current?.id));
          const children = profile.unions.flatMap((union) => union.children.map((child) => ({ union, child })));

          return (
            <div className="book-detail-view ft-person-detail-view">
              <div className="book-detail-topbar">
                <a className="audiobook-back-button" href={back} onClick={(event) => followRoute(event, back)}>
                  <ArrowLeft size={18} aria-hidden="true" />
                  <span>Back</span>
                </a>
              </div>

              <div className="book-detail-head ft-person-detail-head">
                <div className="book-detail-cover-col ft-person-detail-cover-col">
                  <div className="book-detail-cover ft-person-detail-cover" aria-hidden="true">
                    <PersonAvatar person={profile} size={220} />
                    {isAdmin && (
                      <Button
                        variant="icon"
                        className="ft-portrait-button"
                        title="Upload portrait"
                        aria-label="Upload portrait"
                        onClick={() => portraitFileRef.current?.click()}
                      >
                        <Camera size={16} aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                  {isAdmin && (profile.portraitUrl || profile.portraitItemId) && (
                    <div className="book-tags book-tags-under-cover ft-person-cover-actions" aria-label="Portrait actions">
                      <Button variant="text" compact danger onClick={() => void removePortrait()}>
                        Remove portrait
                      </Button>
                    </div>
                  )}
                </div>

                <div className="book-detail-info">
                  <h1 className="book-detail-title">{profile.name}</h1>
                  {subtitle && <p className="book-detail-author ft-person-detail-subtitle">{subtitle}</p>}

                  <dl className="book-detail-meta-grid">
                    <div className="book-detail-meta-item">
                      <CalendarDays size={18} aria-hidden="true" />
                      <dt>Born</dt>
                      <dd>{profile.birthDate ? formatPartialDate(profile.birthDate) : "Unknown"}</dd>
                    </div>
                    <div className="book-detail-meta-item">
                      <MapPin size={18} aria-hidden="true" />
                      <dt>Birthplace</dt>
                      <dd>{profile.birthplace || "Unknown"}</dd>
                    </div>
                    <div className="book-detail-meta-item">
                      <UserRound size={18} aria-hidden="true" />
                      <dt>Gender</dt>
                      <dd>{genderLabel(profile.gender)}</dd>
                    </div>
                    <div className="book-detail-meta-item">
                      <Heart size={18} aria-hidden="true" />
                      <dt>Relationship</dt>
                      <dd>{relationSummary(profile, statusLabel)}</dd>
                    </div>
                  </dl>

                  <div className="book-detail-actions">
                    <div className="book-detail-secondary-actions" aria-label="Person actions">
                      <a
                        className="book-detail-icon-action"
                        href={`/family/tree/${profile.id}`}
                        onClick={(event) => followRoute(event, `/family/tree/${profile.id}`)}
                        title="View in tree"
                        aria-label="View in tree"
                      >
                        <Network size={18} aria-hidden="true" />
                      </a>
                      {isAdmin && (
                        <Button
                          variant="icon"
                          className="book-detail-icon-action"
                          onClick={() => setEditOpen(true)}
                          title="Edit person"
                          aria-label="Edit person"
                        >
                          <Pencil size={18} aria-hidden="true" />
                        </Button>
                      )}
                      {isAdmin && (
                        <Button
                          variant="icon"
                          danger
                          className="book-detail-icon-action"
                          onClick={() => setDeleteOpen(true)}
                          title="Delete person"
                          aria-label="Delete person"
                        >
                          <Trash2 size={18} aria-hidden="true" />
                        </Button>
                      )}
                    </div>
                  </div>

                  <input
                    ref={portraitFileRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    hidden
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (file) void uploadPortrait(file);
                    }}
                  />
                </div>
              </div>

              <section className="book-detail-tabs-section ft-person-detail-tabs-section">
                <nav className="book-detail-tabs" aria-label="Person detail sections">
                  {PERSON_DETAIL_TABS.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      className={activeDetailTab === tab.id ? "active" : ""}
                      onClick={() => setActiveDetailTab(tab.id)}
                    >
                      {tab.label}
                    </button>
                  ))}
                </nav>

                <div className="book-detail-tab-panel ft-person-detail-tab-panel">
                  {activeDetailTab === "family" && (
                    <section className="ft-section ft-profile-section">
                      {isAdmin && (
                        <div className="ft-tab-actions">
                          <ActionMenu
                            label="Add relative"
                            icon={<UserRoundPlus size={15} aria-hidden="true" />}
                            compact
                            items={[
                              {
                                key: "parent",
                                label: "Parent",
                                icon: <UsersRound size={15} aria-hidden="true" />,
                                disabledReason: profile.parents.length >= 2 ? "Both parents are already recorded" : undefined,
                                onSelect: () => setParentModal(true)
                              },
                              {
                                key: "partner",
                                label: "Partner",
                                icon: <Heart size={15} aria-hidden="true" />,
                                onSelect: () => setUnionModal(true)
                              },
                              {
                                key: "child",
                                label: "Child",
                                icon: <Baby size={15} aria-hidden="true" />,
                                onSelect: () => setChildModal(true)
                              },
                              {
                                key: "sibling",
                                label: "Sibling",
                                icon: <UserRound size={15} aria-hidden="true" />,
                                disabledReason: parentUnionId ? undefined : "Record a parent first — siblings share parents",
                                onSelect: () => setSiblingModal(true)
                              }
                            ]}
                          />
                        </div>
                      )}

                      <div className="ft-family-grid">
                        <FamilyGroup title="Parents">
                          {profile.parents.map((parent) => (
                            <RelationCard
                              key={parent.id}
                              person={parent}
                              detail={profile.parentRelation && profile.parentRelation !== "biological" ? profile.parentRelation : undefined}
                            />
                          ))}
                        </FamilyGroup>
                        <FamilyGroup title="Siblings">
                          {family.siblings.map((sibling) => <RelationCard key={sibling.id} person={sibling} />)}
                        </FamilyGroup>
                        <FamilyGroup title="Grandparents">
                          {family.grandparents.map((grandparent) => <RelationCard key={grandparent.id} person={grandparent} />)}
                        </FamilyGroup>
                        <FamilyGroup title={partners.length === 1 ? "Partner" : "Partners"}>
                          {partners.map(({ union, person }) => person && (
                            <RelationCard
                              key={union.id}
                              person={person}
                              detail={[
                                union.id === current?.id ? "Current" : "",
                                statusLabel(union.status),
                                unionDates(union)
                              ].filter(Boolean).join(" · ")}
                              action={isAdmin && (
                                <span className="ft-relation-card-actions">
                                  <Button
                                    variant="icon"
                                    title={`Edit relationship with ${person.name}`}
                                    aria-label={`Edit relationship with ${person.name}`}
                                    onClick={() => setEditUnion(union)}
                                  >
                                    <Pencil size={13} aria-hidden="true" />
                                  </Button>
                                  <Button
                                    variant="icon"
                                    danger
                                    title="Remove this union"
                                    aria-label="Remove this union"
                                    onClick={() => setRemoveUnionId(union.id)}
                                  >
                                    <X size={14} aria-hidden="true" />
                                  </Button>
                                </span>
                              )}
                            />
                          ))}
                        </FamilyGroup>
                        <FamilyGroup title="Children">
                          {children.map(({ union, child }) => (
                            <RelationCard
                              key={`${union.id}-${child.id}`}
                              person={child}
                              detail={child.relation !== "biological" ? child.relation : undefined}
                              action={isAdmin && (
                                <span className="ft-relation-card-actions">
                                  <Button
                                    variant="icon"
                                    danger
                                    title={`Remove ${child.name} from this family`}
                                    aria-label={`Remove ${child.name} from this family`}
                                    onClick={() => void removeChildLink(union.id, child.id)}
                                  >
                                    <X size={14} aria-hidden="true" />
                                  </Button>
                                </span>
                              )}
                            />
                          ))}
                        </FamilyGroup>
                      </div>
                    </section>
                  )}

                  {activeDetailTab === "timeline" && (
                    <section className="ft-section ft-profile-section">
                      {isAdmin && (
                        <div className="ft-tab-actions">
                          <Button variant="secondary" compact onClick={() => setEventModal(null)}>
                            <CalendarPlus size={15} aria-hidden="true" />
                            Add event
                          </Button>
                        </div>
                      )}

                      {entries.length === 0 ? (
                        <div className="ft-empty-panel">
                          <CalendarDays size={22} aria-hidden="true" />
                          <strong>No events yet</strong>
                        </div>
                      ) : (
                        <ol className="ft-timeline">
                          {entries.map((entry) => (
                            <li key={entry.key} className={`ft-timeline-row is-${entry.tone}`}>
                              <span className="ft-timeline-date">{entry.dateText || "—"}</span>
                              <span className="ft-timeline-marker"><TimelineIcon entry={entry} /></span>
                              <span className="ft-timeline-body">
                                <strong>{entry.title}</strong>
                                {entry.meta.length > 0 && <small>{entry.meta.join(" · ")}</small>}
                                {entry.note && <span className="ft-timeline-note">{entry.note}</span>}
                              </span>
                              {isAdmin && entry.event && (
                                <span className="ft-timeline-actions">
                                  <Button
                                    variant="icon"
                                    title="Edit event"
                                    aria-label={`Edit ${entry.title}`}
                                    onClick={() => setEventModal(entry.event)}
                                  >
                                    <Pencil size={14} aria-hidden="true" />
                                  </Button>
                                  <Button
                                    variant="icon"
                                    danger
                                    title="Delete event"
                                    aria-label={`Delete ${entry.title}`}
                                    onClick={() => setRemoveEvent(entry.event)}
                                  >
                                    <Trash2 size={14} aria-hidden="true" />
                                  </Button>
                                </span>
                              )}
                            </li>
                          ))}
                        </ol>
                      )}
                    </section>
                  )}

                  {activeDetailTab === "photos" && (
                    <section className="ft-section ft-profile-section">
                      {isAdmin && (
                        <div className="ft-tab-actions">
                          <Button variant="secondary" compact onClick={() => setLinkModal(true)}>
                            <Link2 size={15} aria-hidden="true" />
                            {profile.galleryPerson ? `Linked: ${profile.galleryPerson.name || "Unnamed"}` : "Link gallery person"}
                          </Button>
                          <Button variant="primary" compact onClick={() => setPhotoPicker(true)}>
                            <ImagePlus size={15} aria-hidden="true" />
                            Add photos
                          </Button>
                        </div>
                      )}

                      {photos.length === 0 ? (
                        <div className="ft-empty-panel">
                          <ImagePlus size={22} aria-hidden="true" />
                          <strong>No photos yet</strong>
                        </div>
                      ) : (
                        <div className="gallery-grid ft-photo-grid">
                          {photos.map((photo) => (
                            <div key={photo.id} className="ft-photo-tile">
                              <a
                                className="gallery-tile"
                                href={`/gallery/assets/${photo.id}?from=/family/people/${profile.id}`}
                                onClick={(event) => followRoute(event, `/gallery/assets/${photo.id}?from=/family/people/${profile.id}`)}
                                title={photo.title}
                              >
                                {photo.coverUrl && <img src={photo.coverUrl} alt={photo.title} loading="lazy" />}
                                {photo.kind === "video" && (
                                  <span className="gallery-video-badge"><Play size={11} aria-hidden="true" />Video</span>
                                )}
                              </a>
                              {isAdmin && photo.attached && (
                                <Button
                                  variant="icon"
                                  danger
                                  className="ft-photo-remove"
                                  title="Remove from this person"
                                  aria-label="Remove from this person"
                                  onClick={() => void detachPhoto(photo.id)}
                                >
                                  <X size={14} aria-hidden="true" />
                                </Button>
                              )}
                            </div>
                          ))}
                          {isAdmin && (
                            <Button
                              variant="secondary"
                              className="ft-photo-add-tile"
                              title="Add photos"
                              aria-label="Add photos"
                              onClick={() => setPhotoPicker(true)}
                            >
                              <ImagePlus size={24} aria-hidden="true" />
                            </Button>
                          )}
                        </div>
                      )}

                      {photos.length < photoTotal && (
                        <Button
                          variant="secondary"
                          onClick={() => {
                            setLoadingMore(true);
                            loadPhotos(photos.length).catch(() => {}).finally(() => setLoadingMore(false));
                          }}
                          disabled={loadingMore}
                        >
                          {loadingMore ? "Loading…" : "Load more"}
                        </Button>
                      )}
                    </section>
                  )}

                  {activeDetailTab === "sources" && (
                    <section className="ft-section ft-profile-section">
                      {isAdmin && (
                        <div className="ft-tab-actions">
                          <Button variant="secondary" compact onClick={() => setCitationModal(null)}>
                            <BookMarked size={15} aria-hidden="true" />
                            Add source
                          </Button>
                        </div>
                      )}

                      {profile.citations.length === 0 ? (
                        <div className="ft-empty-panel">
                          <BookMarked size={22} aria-hidden="true" />
                          <strong>No sources yet</strong>
                        </div>
                      ) : (
                        <ul className="ft-citations">
                          {profile.citations.map((citation) => {
                            const link = citation.url || citation.sourceUrl;
                            return (
                              <li key={citation.id} className="ft-citation-row">
                                <span className="ft-citation-context">{citationContext(citation, profile)}</span>
                                <span className="ft-citation-body">
                                  <strong>
                                    {link ? (
                                      <a href={link} target="_blank" rel="noreferrer noopener">
                                        {citation.sourceTitle}
                                        <ExternalLink size={12} aria-hidden="true" />
                                      </a>
                                    ) : citation.sourceTitle}
                                  </strong>
                                  {citation.detail && <small>{citation.detail}</small>}
                                  {citation.note && <small className="ft-citation-note">{citation.note}</small>}
                                </span>
                                {isAdmin && (
                                  <span className="ft-timeline-actions">
                                    <Button
                                      variant="icon"
                                      title="Edit citation"
                                      aria-label={`Edit citation of ${citation.sourceTitle}`}
                                      onClick={() => setCitationModal(citation)}
                                    >
                                      <Pencil size={14} aria-hidden="true" />
                                    </Button>
                                    <Button
                                      variant="icon"
                                      danger
                                      title="Remove citation"
                                      aria-label={`Remove citation of ${citation.sourceTitle}`}
                                      onClick={() => setRemoveCitation(citation)}
                                    >
                                      <Trash2 size={14} aria-hidden="true" />
                                    </Button>
                                  </span>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </section>
                  )}

                  {activeDetailTab === "notes" && (
                    <section className="ft-section ft-profile-section">
                      {isAdmin && (
                        <div className="ft-tab-actions">
                          <Button variant="secondary" compact onClick={() => setEditOpen(true)}>
                            <FileText size={15} aria-hidden="true" />
                            Edit notes
                          </Button>
                        </div>
                      )}

                      {profile.bio ? (
                        <p className="ft-profile-bio">{profile.bio}</p>
                      ) : (
                        <div className="ft-empty-panel">
                          <FileText size={22} aria-hidden="true" />
                          <strong>No notes yet</strong>
                        </div>
                      )}
                    </section>
                  )}
                </div>
              </section>
            </div>
          );
        })()}
        </div>
      </section>

      {editOpen && profile && (
        <PersonEditModal
          person={profile}
          onClose={() => setEditOpen(false)}
          onSaved={() => { setEditOpen(false); refresh(); }}
        />
      )}
      {deleteOpen && profile && (
        <ConfirmDialog
          title={`Delete "${profile.name}"?`}
          confirmLabel="Delete person"
          busyLabel="Deleting…"
          danger
          busy={deleting}
          error={deleteError}
          onConfirm={() => void deletePerson()}
          onCancel={() => setDeleteOpen(false)}
        >
          This removes {profile.name} from the family tree. Their relatives, children, and gallery photos are kept —
          a remaining partner keeps their children.
        </ConfirmDialog>
      )}
      {removeUnionId && (
        <ConfirmDialog
          title="Remove this union?"
          confirmLabel="Remove union"
          danger
          onConfirm={() => void removeUnion()}
          onCancel={() => setRemoveUnionId(null)}
        >
          The partnership and its children links are removed. No people or photos are deleted.
        </ConfirmDialog>
      )}
      {eventModal !== false && profile && (
        <EventEditModal
          personId={profile.id}
          personName={profile.name}
          event={eventModal}
          onClose={() => setEventModal(false)}
          onSaved={() => { setEventModal(false); refresh(); }}
        />
      )}
      {removeEvent && (
        <ConfirmDialog
          title={`Delete "${removeEvent.label || eventTypeLabel(removeEvent.type)}"?`}
          confirmLabel="Delete event"
          danger
          onConfirm={() => void deleteEvent()}
          onCancel={() => setRemoveEvent(null)}
        >
          This removes the event from the timeline. Nothing else is affected.
        </ConfirmDialog>
      )}
      {citationModal !== false && profile && (
        <CitationEditModal
          profile={profile}
          citation={citationModal}
          onClose={() => setCitationModal(false)}
          onSaved={() => { setCitationModal(false); refresh(); }}
        />
      )}
      {removeCitation && (
        <ConfirmDialog
          title={`Remove citation of "${removeCitation.sourceTitle}"?`}
          confirmLabel="Remove citation"
          danger
          onConfirm={() => void deleteCitation()}
          onCancel={() => setRemoveCitation(null)}
        >
          The citation is removed from this fact. The source itself stays available for other citations.
        </ConfirmDialog>
      )}
      {unionModal && profile && (
        <AddUnionModal
          person={profile}
          onClose={() => setUnionModal(false)}
          onAdded={() => { setUnionModal(false); refresh(); }}
        />
      )}
      {childModal && profile && (
        <AddChildModal
          person={profile}
          onClose={() => setChildModal(false)}
          onAdded={() => { setChildModal(false); refresh(); }}
        />
      )}
      {parentModal && profile && (
        <AddParentModal
          person={profile}
          parentUnionId={parentUnionId}
          onClose={() => setParentModal(false)}
          onAdded={() => { setParentModal(false); refresh(); }}
        />
      )}
      {siblingModal && profile && parentUnionId && (
        <AddSiblingModal
          person={profile}
          parentUnionId={parentUnionId}
          siblingIds={siblingIds}
          onClose={() => setSiblingModal(false)}
          onAdded={() => { setSiblingModal(false); refresh(); }}
        />
      )}
      {editUnion && profile && (
        <UnionEditModal
          union={editUnion}
          personName={profile.name}
          onClose={() => setEditUnion(null)}
          onSaved={() => { setEditUnion(null); refresh(); }}
        />
      )}
      {photoPicker && profile && (
        <FamilyPhotoPicker
          title={`Add photos of ${profile.name}`}
          existingIds={photos.filter((p) => p.attached).map((p) => p.id)}
          onAttach={async (itemIds) => {
            await api(`/api/family-tree/persons/${profile.id}/photos`, {
              method: "POST",
              body: JSON.stringify({ itemIds })
            });
            loadPhotos(0).catch(() => {});
          }}
          onClose={() => setPhotoPicker(false)}
        />
      )}
      {linkModal && profile && (
        <GalleryPersonLinkModal
          person={profile}
          onClose={() => setLinkModal(false)}
          onUpdated={() => { setLinkModal(false); refresh(); }}
        />
      )}
    </DashboardShell>
  );
}
