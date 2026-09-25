import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { SelectField } from "../../../shared/SelectField";
import type { AccessOverview, AccessSubject, GrantRole, GrantView, InheritedGrant, PeopleAccess } from "./types";

// Everything one person can reach (docs/people-sharing-plan.md, phase 2, D13),
// as the pieces a member's page is built from (features/control/members); the
// hook also serves a group's page, which shows its members only. Each tab
// shows what was given DIRECTLY, which it can change, beside what they get
// from elsewhere (a group, the household's Everyone baseline), which it names
// in words instead. Writes go through the routes each object already has, so a
// library's Members dialog and these always agree.
//
// Access — groups, libraries, people, the tree — saves as each choice is made,
// since each one is its own grant. Who someone IS (their tree person and Gallery
// face) sits with their groups: it describes them, and grants nothing.

const EVERYONE_GROUP_ID = "grp-everyone";
const SYSTEM_GROUP_IDS = new Set([EVERYONE_GROUP_ID, "grp-system-admins"]);

/** The subject's access, loaded once and reloaded after every write. */
export function useAccessSubject(subject: AccessSubject) {
  const { t } = useTranslation(["controlAdmin"]);
  const [overview, setOverview] = useState<AccessOverview | null>(null);
  const [people, setPeople] = useState<PeopleAccess | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const base = `${subject.subjectType}/${encodeURIComponent(subject.subjectId)}`;
  const reload = useCallback(async () => {
    const [nextOverview, nextPeople] = await Promise.all([
      api<AccessOverview>(`/api/access/${base}`),
      api<PeopleAccess>(`/api/library/gallery/access/${base}`)
    ]);
    setOverview(nextOverview);
    setPeople(nextPeople);
  }, [base]);

  useEffect(() => {
    reload().catch((err) => setError(err instanceof Error ? err.message : t("controlAdmin:access.errors.load")));
  }, [reload, t]);

  // One write, then everything reloads: an inherited right may change with it.
  const write = useCallback(async (run: () => Promise<unknown>, onDone?: () => void) => {
    setBusy(true);
    setError("");
    try {
      await run();
      await reload();
      onDone?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:access.errors.save"));
    } finally {
      setBusy(false);
    }
  }, [reload, t]);

  const body = useCallback((payload: object) => ({
    method: "POST",
    body: JSON.stringify({ subjectType: subject.subjectType, subjectId: subject.subjectId, ...payload })
  }), [subject.subjectType, subject.subjectId]);

  return { overview, people, error, setError, busy, setBusy, reload, write, base, body, del: { method: "DELETE" } as const };
}

export type AccessSubjectState = ReturnType<typeof useAccessSubject>;

/** The words the tables use for a grant. */
export function useGrantWords() {
  const { t } = useTranslation(["controlAdmin", "control"]);
  const libraryRole = (role: GrantRole) => t(`control:libraries.role.${role}`);
  // The empty choice: nothing given here — which, for someone with a group or the
  // household behind them, means "whatever those give".
  const noDirectLabel = (view: GrantView) => (view.inherited.some((g) => g.role !== "deny")
    ? t("controlAdmin:access.libraries.sameAsGroups")
    : t("controlAdmin:access.libraries.noAccess"));
  // The Access column: the role they end up with and its source, as two lines
  // rather than one sentence.
  const access = (view: GrantView, label: (role: GrantRole) => string): { role: string; source: string; none: boolean; blocked: boolean } => {
    if (view.effective == null) {
      const blocked = view.direct === "deny" || view.inherited.some((g) => g.role === "deny");
      return { role: blocked ? t("controlAdmin:access.blocked") : t("controlAdmin:access.none"), source: "", none: !blocked, blocked };
    }
    const role = label(view.effective);
    if (view.direct === view.effective) return { role, source: t("controlAdmin:member.libraries.givenDirectly"), none: false, blocked: false };
    const from = view.inherited.find((g) => g.role === view.effective);
    if (from?.via === "group") return { role, source: t("controlAdmin:access.fromGroup", { group: from.groupName ?? "" }), none: false, blocked: false };
    if (from?.via === "everyone") return { role, source: t("controlAdmin:member.libraries.fromHousehold"), none: false, blocked: false };
    return { role, source: "", none: false, blocked: false };
  };
  return { libraryRole, noDirectLabel, access };
}

/** The Inbox reviewer choice as the select's value: "" · "details" · "keep". */
export function inboxLevel(inbox: GrantView): "" | "details" | "keep" {
  return inbox.direct === "manager" ? "keep" : inbox.direct === "contributor" ? "details" : "";
}

/** What one group gives, in one line — the reason it is worth being in. */
export function groupGives(overview: AccessOverview, groupId: string, editsBranch: (branch: string) => string): string {
  // The household (Everyone) is tagged by kind, not by id, on what it gives.
  const from = (g: InheritedGrant) => (groupId === EVERYONE_GROUP_ID ? g.via === "everyone" : g.groupId === groupId);
  return [
    ...overview.libraries.filter((l) => l.inherited.some((g) => from(g) && g.role !== "deny")).map((l) => l.name),
    ...overview.branches.filter((b) => b.inherited.some((g) => from(g) && g.role === "contributor")).map((b) => editsBranch(b.name))
  ].join(", ");
}

/** The wording groupGives needs, from a controlAdmin t(). */
export function editsBranchWords(t: (key: "controlAdmin:access.groups.editsBranch", options: { branch: string }) => string) {
  return (branch: string) => t("controlAdmin:access.groups.editsBranch", { branch });
}

/** The groups a person is in, as chips, with the picker to add one at the end. */
export function GroupChips({ overview, busy, onAdd, onRemove }: {
  overview: AccessOverview;
  busy: boolean;
  onAdd: (groupId: string) => void;
  onRemove: (groupId: string) => void;
}) {
  const { t } = useTranslation(["controlAdmin"]);
  const [all, setAll] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    api<{ groups: { id: string; name: string }[] }>("/api/groups")
      .then((payload) => setAll(payload.groups.filter((group) => !SYSTEM_GROUP_IDS.has(group.id))))
      .catch(() => setAll([]));
  }, []);
  const mine = new Set(overview.groups.map((group) => group.id));
  const addable = all.filter((group) => !mine.has(group.id));
  return (
    <div className="access-chips">
      {overview.groups.length === 0 && <span className="access-muted">{t("controlAdmin:access.groups.none")}</span>}
      {overview.groups.map((group) => (
        <span className="access-chip" key={group.id} title={groupGives(overview, group.id, editsBranchWords(t)) || t("controlAdmin:access.groups.givesNothing")}>
          {group.name}
          <Button
            variant="icon"
            className="access-chip-remove"
            disabled={busy}
            aria-label={t("controlAdmin:access.groups.removeFrom", { group: group.name })}
            title={t("controlAdmin:access.groups.removeFrom", { group: group.name })}
            onClick={() => onRemove(group.id)}
          >
            <X size={13} aria-hidden="true" />
          </Button>
        </span>
      ))}
      {addable.length > 0 && (
        <SelectField
          label={t("controlAdmin:access.groups.add")}
          hideLabel
          compact
          value=""
          disabled={busy}
          onChange={(groupId) => { if (groupId) onAdd(groupId); }}
          options={[{ value: "", label: t("controlAdmin:access.groups.choose") }, ...addable.map((group) => ({ value: group.id, label: group.name }))]}
        />
      )}
    </div>
  );
}

// "Who Sam is" (D12, Q1): their person in the family tree and their face in the
// Gallery, side by side. Neither grants anything — the tree says "You" and keeps
// no detail of theirs from them; showing them photos of themselves is a choice on
// Photos of people. Picking a tree person fills in its face when none is set.
export function WhoTheyAre({ me, face, busy, onTreePerson, onFace }: {
  me: { personId: string; name: string; galleryPersonId: string | null } | null;
  face: { personId: string; name: string } | null;
  busy: boolean;
  onTreePerson: (personId: string | null, galleryPersonId: string | null) => void;
  onFace: (personId: string | null) => void;
}) {
  const { t } = useTranslation(["controlAdmin"]);
  const [persons, setPersons] = useState<{ id: string; name: string; galleryPersonId?: string | null }[]>([]);
  const [faces, setFaces] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    api<{ persons: { id: string; name: string; galleryPersonId?: string | null }[] }>("/api/family-tree/persons")
      .then((payload) => setPersons(payload.persons))
      .catch(() => setPersons([]));
    api<{ people: { id: string; name: string }[] }>("/api/library/gallery/people")
      .then((payload) => setFaces(payload.people.filter((person) => person.name.trim())))
      .catch(() => setFaces([]));
  }, []);
  const treeFace = me?.galleryPersonId ?? null;
  return (
    <div className="access-profile-grid">
      <SelectField
        label={t("controlAdmin:access.who.tree")}
        value={me?.personId ?? ""}
        disabled={busy}
        onChange={(personId) => onTreePerson(personId || null, persons.find((p) => p.id === personId)?.galleryPersonId ?? null)}
        options={[
          { value: "", label: t("controlAdmin:access.family.meNone") },
          ...(me && !persons.some((p) => p.id === me.personId) ? [{ value: me.personId, label: me.name }] : []),
          ...persons.map((person) => ({ value: person.id, label: person.name }))
        ]}
      />
      <SelectField
        label={t("controlAdmin:access.who.face")}
        value={face?.personId ?? ""}
        disabled={busy}
        onChange={(personId) => onFace(personId || null)}
        hint={treeFace && face?.personId !== treeFace ? (
          <Button variant="text" compact disabled={busy} onClick={() => onFace(treeFace)}>{t("controlAdmin:access.family.meUseFace")}</Button>
        ) : undefined}
        options={[
          { value: "", label: t("controlAdmin:access.photos.selfNone") },
          ...(face && !faces.some((p) => p.id === face.personId) ? [{ value: face.personId, label: face.name }] : []),
          ...faces.map((person) => ({ value: person.id, label: person.name }))
        ]}
      />
    </div>
  );
}
