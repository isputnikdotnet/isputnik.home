import { Children, useCallback, useEffect, useState } from "react";
import {
  Armchair, ArrowLeft, Award, Baby, BookMarked, BriefcaseBusiness, CalendarDays, CalendarPlus, Camera, Church,
  ExternalLink, FileText, Flag, GraduationCap, Heart, Home as HomeIcon, ImagePlus, Images, Link2, Luggage, MapPin,
  Network, Pencil, Plane, Play, Send, Shield, Tags, Trash2, UserRound, UserRoundPlus, UsersRound, X
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { followBack, followRoute, getReferrer, navigate } from "../../router";
import { ActionMenu } from "../../shared/ActionMenu";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { SectionNav } from "../../shared/SectionNav";
import { familyNavProps } from "./sectionNavItems";
import { MessageBox } from "../../shared/MessageBox";
import { SendToSheet } from "../social/SendToSheet";
import { NotesSection } from "../social/NotesSection";
import { GalleryLightbox } from "../gallery/GalleryLightbox";
import type { GalleryAsset } from "../gallery/types";
import { faceFocusStyle } from "../gallery/types";
import { AddChildModal } from "./AddChildModal";
import { AddParentModal } from "./AddParentModal";
import { AddSiblingModal } from "./AddSiblingModal";
import { AddUnionModal } from "./AddUnionModal";
import { CitationEditModal } from "./CitationEditModal";
import { EventEditModal } from "./EventEditModal";
import { PhotoPicker } from "../gallery/PhotoPicker";
import { useFamilyUploadTarget } from "./useFamilyUploadTarget";
import { GalleryPersonLinkModal } from "./GalleryPersonLinkModal";
import { PersonAvatar } from "./PersonAvatar";
import { PersonEditModal } from "./PersonEditModal";
import { UnionEditModal } from "./UnionEditModal";
import i18n from "../../i18n";
import {
  lifeYears, childRelationLabel, childRelativeNoun, eventTypeLabel, genderLabel, unionStatusLabel,
  type FamilyCitation, type FamilyEvent, type FamilyPerson, type FamilyPersonProfile, type FamilyPhoto,
  type FamilyTree, type FamilyUnionDetail
} from "./types";

const PHOTO_PAGE = 40;
// The Photos tab is a preview, not a browser: it shows this many and then links
// to the person's full photos page. Photos still open in a lightbox in place —
// clicking one must never strand the reader in the gallery.
const PHOTO_PREVIEW = 12;
const PERSON_DETAIL_TAB_IDS = ["family", "timeline", "photos", "sources", "biography"] as const;

type PersonDetailTabId = typeof PERSON_DETAIL_TAB_IDS[number];

function personTabLabel(id: PersonDetailTabId, t: TFunction<readonly ["common", "family"], undefined>): string {
  return t(`family:person.tabs.${id}`);
}

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
    .toLocaleString(i18n.language, { month: "short", timeZone: "UTC" });
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
      title: i18n.t("family:person.meta.born"),
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
        title: i18n.t("family:person.timeline.married", { name: union.partner.name }),
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
        title: i18n.t("family:person.timeline.divorced", { name: union.partner.name }),
        meta: [],
        note: null,
        tone: "union",
        event: null
      });
    }
    for (const child of union.children) {
      const noun = childRelativeNoun(child.relation, child.gender);
      entries.push({
        key: `child-${child.id}`,
        sortKey: child.birthDate ?? "9998",
        dateText: formatPartialDate(child.birthDate),
        title: i18n.t("family:person.timeline.childBirth", { noun, name: child.name }),
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
      title: i18n.t("family:person.meta.died"),
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
    if (!event) return i18n.t("family:citation.context.eventFallback");
    const what = event.label || eventTypeLabel(event.type);
    return event.date ? i18n.t("family:citation.eventWithYear", { what, year: event.date.slice(0, 4) }) : what;
  }
  if (citation.unionId) {
    const union = profile.unions.find((u) => u.id === citation.unionId);
    const partner = union?.partner?.name;
    if (citation.fact === "divorce") {
      return partner ? i18n.t("family:citation.targetDivorce", { name: partner }) : i18n.t("family:citation.context.divorcePlain");
    }
    return partner ? i18n.t("family:citation.targetMarriage", { name: partner }) : i18n.t("family:citation.context.marriagePlain");
  }
  if (citation.fact === "name") return i18n.t("family:citation.targetName");
  if (citation.fact === "birth") return i18n.t("family:citation.targetBirth");
  if (citation.fact === "death") return i18n.t("family:citation.targetDeath");
  return i18n.t("family:citation.context.general");
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

/** Grandparents, still attached to the parent they came through. */
interface GrandparentGroup {
  parent: RelationPerson;
  people: RelationPerson[];
}

function extendedFamily(profile: FamilyPersonProfile, tree: FamilyTree | null) {
  if (!tree) return { siblings: [] as RelationPerson[], grandparentGroups: [] as GrandparentGroup[] };
  const personById = new Map(tree.persons.map((person) => [person.id, person]));
  const unionById = new Map(tree.unions.map((union) => [union.id, union]));
  const parentUnionId = tree.children.find((link) => link.childId === profile.id)?.unionId;
  const siblings = parentUnionId
    ? tree.children
        .filter((link) => link.unionId === parentUnionId && link.childId !== profile.id)
        .map((link) => personById.get(link.childId))
        .filter((person): person is FamilyPerson => person != null)
    : [];
  // Grouped by the parent they came through, not flattened into one row. Four
  // names in a line say "these are your grandparents"; two pairs, each under the
  // parent they belong to, say which side of the family each one is — which is
  // the question anybody actually has when they look.
  const grandparentGroups = profile.parents.flatMap((parent) => {
    const parentParentUnionId = tree.children.find((link) => link.childId === parent.id)?.unionId;
    const union = parentParentUnionId ? unionById.get(parentParentUnionId) : undefined;
    if (!union) return [];
    const people = uniquePeople(
      [union.person1Id, union.person2Id]
        .map((personId) => (personId ? personById.get(personId) : null))
        .filter((person): person is FamilyPerson => person != null)
        // Nothing stops a tree recording somebody as a partner in the very union
        // they are a child of, which would list a parent among their own parents.
        // Cheap to refuse, and it stays out of the way otherwise — a grandparent
        // who merely SHARES a parent’s name is a different person and still shows,
        // told apart by their dates, which is how namesakes work.
        .filter((person) => person.id !== parent.id)
    );
    // A recorded union with nobody left in it has nothing to show.
    return people.length > 0 ? [{ parent, people }] : [];
  });
  return { siblings: uniquePeople(siblings), grandparentGroups };
}

// What this person is TO the person whose page this is. The tree shows who is
// related and, through its shape, roughly how — but "Father" and "Sister" say it
// outright, which is the difference between a chart you read and one you work
// out. Gendered where the record says so, neutral where it doesn't: an unknown
// gender gets "Parent", never a guess.
type RelationKind = "parent" | "sibling" | "grandparent" | "child" | "partner";

function relationWord(kind: RelationKind, person: Pick<FamilyPerson, "gender">): string {
  const genderKey = person.gender === "male" || person.gender === "female" ? person.gender : "neutral";
  return i18n.t(`family:relationWord.${kind}.${genderKey}`);
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
  if (married && divorced) return i18n.t("family:person.unionDates.range", { start: married, end: divorced });
  if (married) return i18n.t("family:person.unionDates.since", { date: married });
  if (divorced) return i18n.t("family:person.unionDates.until", { date: divorced });
  return "";
}

function relationSummary(profile: FamilyPersonProfile): string {
  const current = currentUnion(profile);
  if (current?.partner) {
    if (current.status === "married") return i18n.t("family:person.relationshipSummary.marriedTo", { name: current.partner.name });
    if (current.status === "partners") return i18n.t("family:person.relationshipSummary.togetherWith", { name: current.partner.name });
    return i18n.t("family:person.relationshipSummary.statusWithPartner", {
      status: unionStatusLabel(current.status),
      name: current.partner.name
    });
  }
  const past = [...profile.unions]
    .filter((item) => item.partner)
    .sort((a, b) => (b.divorcedDate ?? "").localeCompare(a.divorcedDate ?? ""))[0];
  if (!past?.partner) {
    return profile.unions.some((item) => item.children.length > 0)
      ? i18n.t("family:person.relationshipSummary.parentOnly")
      : i18n.t("family:person.relationshipSummary.noPartnerRecorded");
  }
  if (past.status === "widowed") return i18n.t("family:person.relationshipSummary.widowedFrom", { name: past.partner.name });
  return i18n.t("family:person.relationshipSummary.divorcedFrom", { name: past.partner.name });
}

function TimelineIcon({ entry }: { entry: TimelineEntry }) {
  if (entry.tone === "birth") return <Baby size={16} aria-hidden="true" />;
  if (entry.tone === "union") return <Heart size={16} aria-hidden="true" />;
  if (entry.tone === "death") return <FileText size={16} aria-hidden="true" />;
  if (entry.event?.type === "education" || entry.event?.type === "graduation") return <GraduationCap size={16} aria-hidden="true" />;
  if (entry.event?.type === "occupation") return <BriefcaseBusiness size={16} aria-hidden="true" />;
  if (entry.event?.type === "retirement") return <Armchair size={16} aria-hidden="true" />;
  if (entry.event?.type === "residence") return <HomeIcon size={16} aria-hidden="true" />;
  if (entry.event?.type === "military") return <Shield size={16} aria-hidden="true" />;
  if (entry.event?.type === "immigration" || entry.event?.type === "emigration") return <Plane size={16} aria-hidden="true" />;
  if (entry.event?.type === "naturalization") return <Flag size={16} aria-hidden="true" />;
  if (entry.event?.type === "travel") return <Luggage size={16} aria-hidden="true" />;
  if (entry.event?.type === "award") return <Award size={16} aria-hidden="true" />;
  if (entry.event?.type === "baptism") return <Church size={16} aria-hidden="true" />;
  if (entry.event?.type === "burial") return <MapPin size={16} aria-hidden="true" />;
  return <CalendarDays size={16} aria-hidden="true" />;
}

// Above this many characters a timeline note starts clamped, with a More toggle.
const NOTE_CLAMP_CHARS = 200;
// Photos shown on a collapsed timeline row before the "+N" tile.
const EVENT_PHOTO_PREVIEW = 4;

function RelationCard({
  person,
  detail,
  badge,
  action
}: {
  person: RelationPerson;
  detail?: string;
  /** "Father", "Sister" — what they are to the person whose page this is. */
  badge?: string;
  action?: React.ReactNode;
}) {
  const { t } = useTranslation(["family"]);
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
          <small>
            {badge && <span className="ft-relation-badge">{badge}</span>}
            {detail || lifeYears(person) || t("family:common.lifeDatesUnknown")}
          </small>
        </span>
      </a>
      {action}
    </span>
  );
}

// One generation of the little tree on a person's Relationships tab.
//
// This used to be FamilyGroup — a labelled grid per category: Parents,
// Siblings, Grandparents, Partners, Children. Five lists say who is related but
// not HOW: which parent goes with which, which siblings share which parent,
// which children came from which partnership. A second marriage is unreadable
// in that shape, and relationships are the one thing on this page that are
// inherently spatial.
//
// So the same cards are laid out by generation, oldest at the top, with the
// person themselves marked in their own row. Every action the grid carried —
// edit a union, remove a child link, add a relative — is still here; only the
// arrangement changed.
//
// Rows are skipped entirely when empty rather than printing "None recorded"
// five times: a tree with three empty branches drawn is mostly apology.
function FamilyRow({
  title,
  children,
  connector = true
}: {
  title: string;
  children: React.ReactNode;
  /** Draw the stem down to the next row. False on the last row. */
  connector?: boolean;
}) {
  const items = Children.toArray(children).filter(Boolean);
  if (items.length === 0) return null;
  return (
    <div className={`ft-tree-row${connector ? " has-connector" : ""}`}>
      <h3 className="ft-tree-row-label">{title}</h3>
      <div className="ft-tree-row-cards">{items}</div>
    </div>
  );
}

// One family member: profile fields, relationships, and the merged photo wall
// (curated attachments + linked face-cluster photos). Admins edit everything;
// branch editors (a tag grant, see server access.ts) edit their tagged people;
// everyone else gets a read-only view of the same layout. Deleting the person,
// removing relationships, tags, and the gallery link stay admin-only.
export function FamilyPersonPage({ id, user, logout }: { id: string; user: PublicUser; logout: () => Promise<void> }) {
  const { t } = useTranslation(["common", "family"]);
  const isAdmin = user.role === "admin";
  const [profile, setProfile] = useState<FamilyPersonProfile | null>(null);
  const [familyTree, setFamilyTree] = useState<FamilyTree | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState("");
  const [photos, setPhotos] = useState<FamilyPhoto[]>([]);
  const [photoTotal, setPhotoTotal] = useState(0);
  // Lightbox opened from this page: `assets` is the set it pages through, so a
  // timeline event's strip browses that event's photos, not the whole wall.
  const [lightbox, setLightbox] = useState<{ assets: GalleryAsset[]; index: number } | null>(null);

  const [editOpen, setEditOpen] = useState(false);
  const [sendToOpen, setSendToOpen] = useState(false);
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
  // Timeline rows start collapsed: long notes clamp, photo strips show a few.
  const [expandedNotes, setExpandedNotes] = useState<Set<string>>(new Set());
  const [expandedEventPhotos, setExpandedEventPhotos] = useState<Set<string>>(new Set());
  const [portraitPicker, setPortraitPicker] = useState(false);
  const uploadTo = useFamilyUploadTarget();

  const loadProfile = useCallback(async () => {
    try {
      const payload = await api<{ person: FamilyPersonProfile }>(`/api/family-tree/persons/${id}`);
      setProfile(payload.person);
      setNotFound(false);
    } catch (err) {
      if ((err as { status?: number }).status === 404) setNotFound(true);
      else setError(err instanceof Error ? err.message : t("family:person.errors.loadPerson"));
    }
  }, [id, t]);

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
      setDeleteError(err instanceof Error ? err.message : t("family:person.errors.deletePerson"));
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
      setActionError(err instanceof Error ? err.message : t("family:person.errors.removeUnion"));
      setRemoveUnionId(null);
    }
  };

  const removeChildLink = async (unionId: string, childId: string) => {
    try {
      await api(`/api/family-tree/unions/${unionId}/children/${childId}`, { method: "DELETE" });
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("family:person.errors.removeChildLink"));
    }
  };

  const deleteEvent = async () => {
    if (!removeEvent) return;
    try {
      await api(`/api/family-tree/events/${removeEvent.id}`, { method: "DELETE" });
      setRemoveEvent(null);
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("family:person.errors.deleteEvent"));
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
      setActionError(err instanceof Error ? err.message : t("family:person.errors.removeCitation"));
      setRemoveCitation(null);
    }
  };

  const detachPhoto = async (itemId: string) => {
    try {
      await api(`/api/family-tree/persons/${id}/photos/${itemId}`, { method: "DELETE" });
      setPhotos((prev) => prev.filter((p) => p.id !== itemId));
      setPhotoTotal((prev) => Math.max(0, prev - 1));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("family:person.errors.removePhoto"));
    }
  };

  // Every portrait is a gallery item now — a face match, a browsed photo, or a
  // file uploaded into the tree's photo library, which becomes an item like any
  // other. Setting one clears an uploaded portrait left over from before.
  const setPortraitFromGallery = async (itemId: string) => {
    setActionError("");
    try {
      await api(`/api/family-tree/persons/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ portraitItemId: itemId })
      });
      setPortraitPicker(false);
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("family:person.errors.setPortrait"));
    }
  };

  const removePortrait = async () => {
    setActionError("");
    try {
      await api(`/api/family-tree/persons/${id}/portrait`, { method: "DELETE" });
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("family:person.errors.removePortrait"));
    }
  };

  // Server-computed: true for admins and for tag-granted branch editors.
  const canEdit = profile?.canEdit ?? false;
  const back = getReferrer() ?? "/family/people";
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
      <DashboardShell active="family" user={user} logout={logout} sideNav={<SectionNav {...familyNavProps("people")} />}>
        <section className="audiobook-main-page">
          <MessageBox tone="warning" title={t("family:person.notFoundTitle")}>{t("family:person.notFoundBody")}</MessageBox>
          <p><a href="/family/people" onClick={(event) => followRoute(event, "/family/people")}>{t("family:person.backToFamilyMembers")}</a></p>
        </section>
      </DashboardShell>
    );
  }

  return (
    <DashboardShell active="family" user={user} logout={logout} sideNav={<SectionNav {...familyNavProps("people")} />}>
      <section className="work-area book-detail-area ft-profile-page">
        <div className="book-detail-shell">
          {error && <MessageBox tone="error" title={t("family:common.unableToLoad")}>{error}</MessageBox>}
          {actionError && <MessageBox tone="error" title={t("family:person.errors.actionFailedTitle")}>{actionError}</MessageBox>}

        {profile && (() => {
          const family = extendedFamily(profile, familyTree);
          const entries = timelineEntries(profile);
          const age = ageFromDates(profile.birthDate, profile.deathDate);
          const subtitle = [
            profile.maidenName ? t("family:common.nee", { name: profile.maidenName }) : "",
            lifeYears(profile),
            profile.deathDate ? t("family:person.deceased") : t("family:person.living"),
            age != null ? t("family:person.ageLabel", { age }) : ""
          ].filter(Boolean).join(" · ");
          const current = currentUnion(profile);
          // Current partner first; former unions follow.
          const partners = profile.unions
            .map((union) => ({ union, person: union.partner }))
            .filter((item) => item.person)
            .sort((a, b) => Number(b.union.id === current?.id) - Number(a.union.id === current?.id));
          const children = profile.unions.flatMap((union) => union.children.map((child) => ({ union, child })));
          const hasRelatives = family.grandparentGroups.length > 0
            || profile.parents.length > 0
            || family.siblings.length > 0
            || partners.length > 0
            || children.length > 0;

          return (
            <div className="book-detail-view ft-person-detail-view">
              <div className="book-detail-topbar">
                {/* Icon-only, like a book’s and a photo’s. The app has two back
                    controls: browse pages carry a labelled “Back”, and item detail
                    pages with an action topbar carry the icon. This page joined the
                    second group when its actions moved up. Still an anchor, so
                    middle-click and open-in-new-tab keep working. */}
                <a
                  className="icon-button"
                  href={back}
                  onClick={(event) => followBack(event, back)}
                  title={t("family:common.back")}
                  aria-label={t("family:common.back")}
                >
                  <ArrowLeft size={18} aria-hidden="true" />
                </a>
                <span className="library-toolbar-divider" aria-hidden="true" />
                <div className="book-detail-secondary-actions" aria-label={t("family:person.actions.groupAria")}>
                  <a
                    className="icon-button"
                    href={`/family/tree/${profile.id}`}
                    onClick={(event) => followRoute(event, `/family/tree/${profile.id}`)}
                    title={t("family:person.actions.viewInTree")}
                    aria-label={t("family:person.actions.viewInTree")}
                  >
                    <Network size={18} aria-hidden="true" />
                  </a>
                  <Button
                    variant="icon"
                    onClick={() => setSendToOpen(true)}
                    title={t("family:person.actions.sendTo")}
                    aria-label={t("family:person.actions.sendTo")}
                  >
                    <Send size={18} aria-hidden="true" />
                  </Button>
                  {canEdit && (
                    <Button
                      variant="icon"
                      onClick={() => setEditOpen(true)}
                      title={t("family:common.editPerson")}
                      aria-label={t("family:common.editPerson")}
                    >
                      <Pencil size={18} aria-hidden="true" />
                    </Button>
                  )}
                  {isAdmin && (
                    <Button
                      variant="icon"
                      danger
                      onClick={() => setDeleteOpen(true)}
                      title={t("family:person.actions.deletePerson")}
                      aria-label={t("family:person.actions.deletePerson")}
                    >
                      <Trash2 size={18} aria-hidden="true" />
                    </Button>
                  )}
                </div>
              </div>

              <div className="book-detail-head ft-person-detail-head">
                <div className="book-detail-cover-col ft-person-detail-cover-col">
                  <div className="book-detail-cover ft-person-detail-cover" aria-hidden="true">
                    <PersonAvatar person={profile} size={220} />
                    {canEdit && (
                      <Button
                        variant="icon"
                        className="ft-portrait-button"
                        title={t("family:person.actions.changePortrait")}
                        aria-label={t("family:person.actions.changePortrait")}
                        onClick={() => setPortraitPicker(true)}
                      >
                        <Camera size={16} aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                  {canEdit && (profile.portraitUrl || profile.portraitItemId) && (
                    <div className="book-tags book-tags-under-cover ft-person-cover-actions" aria-label={t("family:person.actions.portraitActionsAria")}>
                      <Button variant="text" compact danger onClick={() => void removePortrait()}>
                        {t("family:person.actions.removePortrait")}
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
                      <dt>{t("family:person.meta.born")}</dt>
                      <dd>{profile.birthDate ? formatPartialDate(profile.birthDate) : t("family:person.meta.unknown")}</dd>
                    </div>
                    <div className="book-detail-meta-item">
                      <MapPin size={18} aria-hidden="true" />
                      <dt>{t("family:person.meta.birthplace")}</dt>
                      <dd>{profile.birthplace || t("family:person.meta.unknown")}</dd>
                    </div>
                    <div className="book-detail-meta-item">
                      <UserRound size={18} aria-hidden="true" />
                      <dt>{t("family:person.meta.gender")}</dt>
                      <dd>{genderLabel(profile.gender)}</dd>
                    </div>
                    <div className="book-detail-meta-item">
                      <Heart size={18} aria-hidden="true" />
                      <dt>{t("family:person.meta.relationship")}</dt>
                      <dd>{relationSummary(profile)}</dd>
                    </div>
                    {profile.tags.length > 0 && (
                      <div className="book-detail-meta-item">
                        <Tags size={18} aria-hidden="true" />
                        <dt>{t("family:person.meta.familyTags")}</dt>
                        <dd>
                          <span className="ft-profile-tags">
                            {profile.tags.map((tag) => (
                              <a
                                key={tag}
                                className="book-tag-chip book-tag-chip-tag"
                                href="/family/people"
                                onClick={(event) => followRoute(event, "/family/people")}
                                title={t("family:person.meta.showTaggedTitle", { tag })}
                              >
                                {tag}
                              </a>
                            ))}
                          </span>
                        </dd>
                      </div>
                    )}
                  </dl>


                </div>
              </div>

              <section className="book-detail-tabs-section ft-person-detail-tabs-section">
                <nav className="book-detail-tabs" aria-label={t("family:person.detailSectionsAria")}>
                  {PERSON_DETAIL_TAB_IDS.map((tabId) => (
                    <button
                      key={tabId}
                      type="button"
                      className={activeDetailTab === tabId ? "active" : ""}
                      onClick={() => setActiveDetailTab(tabId)}
                    >
                      {personTabLabel(tabId, t)}
                    </button>
                  ))}
                </nav>

                <div className="book-detail-tab-panel ft-person-detail-tab-panel">
                  {activeDetailTab === "family" && (
                    <section className="ft-section ft-profile-section">
                      {canEdit && (
                        <div className="ft-tab-actions">
                          <ActionMenu
                            label={t("family:person.addRelativeMenu.label")}
                            icon={<UserRoundPlus size={15} aria-hidden="true" />}
                            compact
                            items={[
                              {
                                key: "parent",
                                label: t("family:relationWord.parent.neutral"),
                                icon: <UsersRound size={15} aria-hidden="true" />,
                                disabledReason: profile.parents.length >= 2 ? t("family:person.addRelativeMenu.disabledBothParents") : undefined,
                                onSelect: () => setParentModal(true)
                              },
                              {
                                key: "partner",
                                label: t("family:relationWord.partner.neutral"),
                                icon: <Heart size={15} aria-hidden="true" />,
                                onSelect: () => setUnionModal(true)
                              },
                              {
                                key: "child",
                                label: t("family:relationWord.child.neutral"),
                                icon: <Baby size={15} aria-hidden="true" />,
                                onSelect: () => setChildModal(true)
                              },
                              {
                                key: "sibling",
                                label: t("family:relationWord.sibling.neutral"),
                                icon: <UserRound size={15} aria-hidden="true" />,
                                disabledReason: parentUnionId ? undefined : t("family:person.addRelativeMenu.disabledNoParent"),
                                onSelect: () => setSiblingModal(true)
                              }
                            ]}
                          />
                        </div>
                      )}

                      {/* Oldest generation first, reading down to the children.
                          The person's own row carries them, their partners and
                          their siblings, which is where a pedigree puts them. */}
                      {hasRelatives ? (
                      <div className="ft-tree">
                        <FamilyRow title={t("family:person.relationships.grandparents")}>
                          {family.grandparentGroups.map((group) => (
                            <div className="ft-tree-branch" key={group.parent.id}>
                              <span className="ft-tree-branch-label">{t("family:person.relationships.viaParent", { name: group.parent.name })}</span>
                              <div className="ft-tree-branch-cards">
                                {group.people.map((grandparent) => (
                                  <RelationCard
                                    key={grandparent.id}
                                    person={grandparent}
                                    badge={relationWord("grandparent", grandparent)}
                                  />
                                ))}
                              </div>
                            </div>
                          ))}
                        </FamilyRow>
                        <FamilyRow title={t("family:person.relationships.parents")}>
                          {profile.parents.map((parent) => (
                            <RelationCard
                              key={parent.id}
                              person={parent}
                              badge={relationWord("parent", parent)}
                              detail={profile.parentRelation && profile.parentRelation !== "biological" ? childRelationLabel(profile.parentRelation) : undefined}
                            />
                          ))}
                        </FamilyRow>

                        <div className={`ft-tree-row ft-tree-self-row${children.length > 0 ? " has-connector" : ""}`}>
                          <h3 className="ft-tree-row-label">
                            {family.siblings.length > 0
                              ? t("family:person.relationships.selfWithPartnersSiblings")
                              : t("family:person.relationships.selfOnly")}
                          </h3>
                          <div className="ft-tree-row-cards">
                            {family.siblings.map((sibling) => (
                              <RelationCard key={sibling.id} person={sibling} badge={relationWord("sibling", sibling)} />
                            ))}

                            {/* Not a link: you are already here. */}
                            <span className="ft-relation-card-wrap">
                              <span className="ft-relation-card is-self" aria-current="page">
                                <PersonAvatar person={profile} size={28} />
                                <span className="ft-relation-card-copy">
                                  <strong>{profile.name}</strong>
                                  <small>{lifeYears(profile) || t("family:common.lifeDatesUnknown")}</small>
                                </span>
                              </span>
                            </span>

                            {partners.map(({ union, person }) => person && (
                            <RelationCard
                              key={union.id}
                              person={person}
                              badge={union.status === "married" ? relationWord("partner", person) : t("family:relationWord.partner.neutral")}
                              detail={[
                                union.id === current?.id ? t("family:person.relationships.current") : "",
                                unionStatusLabel(union.status),
                                unionDates(union)
                              ].filter(Boolean).join(" · ")}
                              action={canEdit && (
                                <span className="ft-relation-card-actions">
                                  <Button
                                    variant="icon"
                                    title={t("family:person.relationships.editRelationshipAria", { name: person.name })}
                                    aria-label={t("family:person.relationships.editRelationshipAria", { name: person.name })}
                                    onClick={() => setEditUnion(union)}
                                  >
                                    <Pencil size={13} aria-hidden="true" />
                                  </Button>
                                  {isAdmin && (
                                    <Button
                                      variant="icon"
                                      danger
                                      title={t("family:person.relationships.removeUnionAria")}
                                      aria-label={t("family:person.relationships.removeUnionAria")}
                                      onClick={() => setRemoveUnionId(union.id)}
                                    >
                                      <X size={14} aria-hidden="true" />
                                    </Button>
                                  )}
                                </span>
                              )}
                            />
                          ))}
                          </div>
                        </div>

                        <FamilyRow title={t("family:person.relationships.children")} connector={false}>
                          {children.map(({ union, child }) => (
                            <RelationCard
                              key={`${union.id}-${child.id}`}
                              person={child}
                              badge={relationWord("child", child)}
                              detail={child.relation !== "biological" ? childRelationLabel(child.relation) : undefined}
                              action={isAdmin && (
                                <span className="ft-relation-card-actions">
                                  <Button
                                    variant="icon"
                                    danger
                                    title={t("family:person.relationships.removeChildAria", { name: child.name })}
                                    aria-label={t("family:person.relationships.removeChildAria", { name: child.name })}
                                    onClick={() => void removeChildLink(union.id, child.id)}
                                  >
                                    <X size={14} aria-hidden="true" />
                                  </Button>
                                </span>
                              )}
                            />
                          ))}
                        </FamilyRow>
                      </div>
                      ) : (
                        <p className="ft-relation-empty">
                          {t("family:person.relationships.emptyBase")}{canEdit ? t("family:person.relationships.emptyHint") : ""}
                        </p>
                      )}
                    </section>
                  )}

                  {activeDetailTab === "timeline" && (
                    <section className="ft-section ft-profile-section">
                      {canEdit && (
                        <div className="ft-tab-actions">
                          <Button variant="secondary" compact onClick={() => setEventModal(null)}>
                            <CalendarPlus size={15} aria-hidden="true" />
                            {t("family:person.timeline.addEventButton")}
                          </Button>
                        </div>
                      )}

                      {entries.length === 0 ? (
                        <div className="ft-empty-panel">
                          <CalendarDays size={22} aria-hidden="true" />
                          <strong>{t("family:person.timeline.noEventsYetTitle")}</strong>
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
                                {entry.note && (() => {
                                  const long = entry.note.length > NOTE_CLAMP_CHARS;
                                  const open = expandedNotes.has(entry.key);
                                  return (
                                    <>
                                      <span className={`ft-timeline-note${long && !open ? " is-clamped" : ""}`}>{entry.note}</span>
                                      {long && (
                                        <button
                                          type="button"
                                          className="ft-timeline-more"
                                          onClick={() => setExpandedNotes((prev) => {
                                            const next = new Set(prev);
                                            if (next.has(entry.key)) next.delete(entry.key); else next.add(entry.key);
                                            return next;
                                          })}
                                        >
                                          {open ? t("family:person.timeline.less") : t("family:person.timeline.more")}
                                        </button>
                                      )}
                                    </>
                                  );
                                })()}
                                {entry.event && entry.event.photos.length > 0 && (() => {
                                  const all = entry.event.photos;
                                  const open = expandedEventPhotos.has(entry.key);
                                  const shown = open ? all : all.slice(0, EVENT_PHOTO_PREVIEW);
                                  const hidden = all.length - shown.length;
                                  const toggle = () => setExpandedEventPhotos((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(entry.key)) next.delete(entry.key); else next.add(entry.key);
                                    return next;
                                  });
                                  return (
                                    <span className="ft-timeline-photos">
                                      {shown.map((photo, photoIndex) => (
                                        <button
                                          key={photo.id}
                                          type="button"
                                          className="ft-timeline-photo"
                                          onClick={() => setLightbox({ assets: all, index: photoIndex })}
                                          title={photo.title}
                                        >
                                          {photo.coverUrl && <img src={photo.coverUrl} alt={photo.title} loading="lazy" style={faceFocusStyle(photo)} />}
                                          {photo.kind === "video" && <Play size={11} className="ft-timeline-photo-play" aria-hidden="true" />}
                                        </button>
                                      ))}
                                      {hidden > 0 && (
                                        <button type="button" className="ft-timeline-photo ft-timeline-photo-more" onClick={toggle}>
                                          +{hidden}
                                        </button>
                                      )}
                                      {open && all.length > EVENT_PHOTO_PREVIEW && (
                                        <button type="button" className="ft-timeline-photo ft-timeline-photo-more" onClick={toggle}>
                                          {t("family:person.timeline.less")}
                                        </button>
                                      )}
                                    </span>
                                  );
                                })()}
                              </span>
                              {canEdit && entry.event && (
                                <span className="ft-timeline-actions">
                                  <Button
                                    variant="icon"
                                    title={t("family:person.timeline.editEventTitle")}
                                    aria-label={t("family:person.timeline.editEventAria", { title: entry.title })}
                                    onClick={() => setEventModal(entry.event)}
                                  >
                                    <Pencil size={14} aria-hidden="true" />
                                  </Button>
                                  <Button
                                    variant="icon"
                                    danger
                                    title={t("family:person.timeline.deleteEventTitle")}
                                    aria-label={t("family:person.timeline.deleteEventAria", { title: entry.title })}
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
                      {canEdit && (
                        <div className="ft-tab-actions">
                          {isAdmin && (
                            <Button variant="secondary" compact onClick={() => setLinkModal(true)}>
                              <Link2 size={15} aria-hidden="true" />
                              {profile.galleryPerson
                                ? t("family:person.photosTab.linkedGalleryPerson", { name: profile.galleryPerson.name || t("family:galleryLink.unnamed") })
                                : t("family:person.photosTab.linkGalleryPerson")}
                            </Button>
                          )}
                          <Button variant="primary" compact onClick={() => setPhotoPicker(true)}>
                            <ImagePlus size={15} aria-hidden="true" />
                            {t("family:common.addPhotos")}
                          </Button>
                        </div>
                      )}

                      {photos.length === 0 ? (
                        <div className="ft-empty-panel">
                          <ImagePlus size={22} aria-hidden="true" />
                          <strong>{t("family:person.photosTab.noPhotosYetTitle")}</strong>
                        </div>
                      ) : (
                        <div className="gallery-grid ft-photo-grid">
                          {photos.slice(0, PHOTO_PREVIEW).map((photo, index) => (
                            <div key={photo.id} className="ft-photo-tile">
                              <button
                                type="button"
                                className="gallery-tile"
                                onClick={() => setLightbox({ assets: photos, index })}
                                title={photo.title}
                              >
                                {photo.coverUrl && <img src={photo.coverUrl} alt={photo.title} loading="lazy" style={faceFocusStyle(photo)} />}
                                {photo.kind === "video" && (
                                  <span className="gallery-video-badge"><Play size={11} aria-hidden="true" />{t("family:common.video")}</span>
                                )}
                              </button>
                              {canEdit && photo.attached && (
                                <Button
                                  variant="icon"
                                  danger
                                  className="ft-photo-remove"
                                  title={t("family:person.photosTab.removeFromPersonAria")}
                                  aria-label={t("family:person.photosTab.removeFromPersonAria")}
                                  onClick={() => void detachPhoto(photo.id)}
                                >
                                  <X size={14} aria-hidden="true" />
                                </Button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {photoTotal > PHOTO_PREVIEW && (
                        <a
                          className="secondary-button compact-button ft-photos-all-link"
                          href={`/family/people/${profile.id}/photos`}
                          onClick={(event) => followRoute(event, `/family/people/${profile.id}/photos`)}
                        >
                          <Images size={16} aria-hidden="true" />
                          {t("family:person.photosTab.viewAllPhotos", { count: photoTotal })}
                        </a>
                      )}
                    </section>
                  )}

                  {activeDetailTab === "sources" && (
                    <section className="ft-section ft-profile-section">
                      {canEdit && (
                        <div className="ft-tab-actions">
                          <Button variant="secondary" compact onClick={() => setCitationModal(null)}>
                            <BookMarked size={15} aria-hidden="true" />
                            {t("family:person.sourcesTab.addSourceButton")}
                          </Button>
                        </div>
                      )}

                      {profile.citations.length === 0 ? (
                        <div className="ft-empty-panel">
                          <BookMarked size={22} aria-hidden="true" />
                          <strong>{t("family:citation.noSourcesTitle")}</strong>
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
                                {canEdit && (
                                  <span className="ft-timeline-actions">
                                    <Button
                                      variant="icon"
                                      title={t("family:citation.titleEdit")}
                                      aria-label={t("family:person.sourcesTab.editCitationAria", { title: citation.sourceTitle })}
                                      onClick={() => setCitationModal(citation)}
                                    >
                                      <Pencil size={14} aria-hidden="true" />
                                    </Button>
                                    <Button
                                      variant="icon"
                                      danger
                                      title={t("family:person.sourcesTab.removeCitationTitle")}
                                      aria-label={t("family:person.sourcesTab.removeCitationAria", { title: citation.sourceTitle })}
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

                  {activeDetailTab === "biography" && (
                    <section className="ft-section ft-profile-section">
                      {canEdit && (
                        <div className="ft-tab-actions">
                          <Button variant="secondary" compact onClick={() => setEditOpen(true)}>
                            <FileText size={15} aria-hidden="true" />
                            {t("family:person.biographyTab.editNotesButton")}
                          </Button>
                        </div>
                      )}

                      {profile.bio ? (
                        <p className="ft-profile-bio">{profile.bio}</p>
                      ) : (
                        <div className="ft-empty-panel">
                          <FileText size={22} aria-hidden="true" />
                          <strong>{t("family:person.biographyTab.noBiographyYetTitle")}</strong>
                        </div>
                      )}
                    </section>
                  )}
                </div>
              </section>

              {profile && <NotesSection entityType="family_tree_person" entityId={profile.id} />}
            </div>
          );
        })()}
        </div>
      </section>

      {sendToOpen && profile && (
        <SendToSheet
          subject={{ entityType: "family_tree_person", entityId: profile.id }}
          onClose={() => setSendToOpen(false)}
        />
      )}

      {editOpen && profile && (
        <PersonEditModal
          person={profile}
          showTags={isAdmin}
          onClose={() => setEditOpen(false)}
          onSaved={() => { setEditOpen(false); refresh(); }}
        />
      )}
      {deleteOpen && profile && (
        <ConfirmDialog
          title={t("family:person.dialogs.deleteTitle", { name: profile.name })}
          confirmLabel={t("family:person.dialogs.deleteConfirmLabel")}
          busyLabel={t("family:person.dialogs.deleteBusyLabel")}
          danger
          busy={deleting}
          error={deleteError}
          onConfirm={() => void deletePerson()}
          onCancel={() => setDeleteOpen(false)}
        >
          {t("family:person.dialogs.deleteBody", { name: profile.name })}
        </ConfirmDialog>
      )}
      {removeUnionId && (
        <ConfirmDialog
          title={t("family:person.dialogs.removeUnionTitle")}
          confirmLabel={t("family:person.dialogs.removeUnionConfirmLabel")}
          danger
          onConfirm={() => void removeUnion()}
          onCancel={() => setRemoveUnionId(null)}
        >
          {t("family:person.dialogs.removeUnionBody")}
        </ConfirmDialog>
      )}
      {eventModal !== false && profile && (
        <EventEditModal
          personId={profile.id}
          personName={profile.name}
          facePerson={profile.galleryPerson}
          event={eventModal}
          onClose={() => setEventModal(false)}
          onSaved={() => { setEventModal(false); refresh(); }}
        />
      )}
      {removeEvent && (
        <ConfirmDialog
          title={t("family:person.dialogs.deleteEventTitle", { title: removeEvent.label || eventTypeLabel(removeEvent.type) })}
          confirmLabel={t("family:person.dialogs.deleteEventConfirmLabel")}
          danger
          onConfirm={() => void deleteEvent()}
          onCancel={() => setRemoveEvent(null)}
        >
          {t("family:person.dialogs.deleteEventBody")}
        </ConfirmDialog>
      )}
      {citationModal !== false && profile && (
        <CitationEditModal
          profile={profile}
          citation={citationModal}
          canEditSources={isAdmin}
          onClose={() => setCitationModal(false)}
          onSaved={() => { setCitationModal(false); refresh(); }}
        />
      )}
      {removeCitation && (
        <ConfirmDialog
          title={t("family:person.dialogs.removeCitationTitle", { title: removeCitation.sourceTitle })}
          confirmLabel={t("family:person.dialogs.removeCitationConfirmLabel")}
          danger
          onConfirm={() => void deleteCitation()}
          onCancel={() => setRemoveCitation(null)}
        >
          {t("family:person.dialogs.removeCitationBody")}
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
      {portraitPicker && profile && (
        <PhotoPicker
          title={t("family:person.portraitPickerTitle", { name: profile.name })}
          pick="any"
          facePerson={profile.galleryPerson}
          uploadTo={uploadTo}
          onPick={(asset) => void setPortraitFromGallery(asset.id)}
          onClose={() => setPortraitPicker(false)}
        />
      )}
      {photoPicker && profile && (
        <PhotoPicker
          title={t("family:person.addPhotosOfTitle", { name: profile.name })}
          existingIds={photos.filter((p) => p.attached).map((p) => p.id)}
          facePerson={profile.galleryPerson}
          uploadTo={uploadTo}
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
      {lightbox && lightbox.assets[lightbox.index] && (
        <GalleryLightbox
          assets={lightbox.assets}
          index={lightbox.index}
          canDelete={false}
          canEdit={false}
          canShare={false}
          onClose={() => setLightbox(null)}
          onIndexChange={(next) => setLightbox((current) => (current ? { ...current, index: next } : current))}
          onChanged={refresh}
        />
      )}
    </DashboardShell>
  );
}
