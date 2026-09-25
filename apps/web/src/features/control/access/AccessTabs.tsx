import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { SelectField } from "../../../shared/SelectField";
import type { AccessOverview, AccessSubject, GrantRole, GrantView, InheritedGrant, PeopleAccess } from "./types";

// Everything one person — or one group — can reach (docs/people-sharing-plan.md,
// phase 2, D13), as the pieces two surfaces share: a member's page
// (members/MemberPage) and a group's Access dialog (AccessDialog). Each tab shows
// what was given DIRECTLY, which it can change, beside what they get from
// elsewhere (a group, the household's Everyone baseline), which it names in
// words instead. Writes go through the routes each object already has, so a
// library's Members dialog and these always agree.
//
// Access — groups, libraries, people, the tree — saves as each choice is made,
// since each one is its own grant. Who someone IS (their tree person and Gallery
// face) sits with their groups: it describes them, and grants nothing.

const EVERYONE_GROUP_ID = "grp-everyone";
const SYSTEM_GROUP_IDS = new Set([EVERYONE_GROUP_ID, "grp-system-admins"]);
const LIBRARY_ROLES: GrantRole[] = ["viewer", "member", "contributor", "manager", "deny"];
const COLLECTION_ROLES = ["viewer", "contributor", "manager", "deny"] as const;

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

/** "What they get" — the role and where it comes from — in words. */
export function useGrantWords(isUser: boolean) {
  const { t } = useTranslation(["controlAdmin", "control"]);
  const gets = (view: GrantView, label: (role: GrantRole) => string): string => {
    if (!isUser) {
      const everyone = view.inherited.find((g) => g.via === "everyone");
      return everyone ? t("controlAdmin:access.fromEveryone", { role: label(everyone.role) }) : "";
    }
    if (view.effective == null) {
      return view.direct === "deny" || view.inherited.some((g) => g.role === "deny") ? t("controlAdmin:access.blocked") : t("controlAdmin:access.none");
    }
    if (view.direct === view.effective) return label(view.effective);
    const source = view.inherited.find((g) => g.role === view.effective);
    if (source?.via === "group") return t("controlAdmin:access.viaGroup", { role: label(view.effective), group: source.groupName ?? "" });
    if (source?.via === "everyone") return t("controlAdmin:access.viaEveryone", { role: label(view.effective) });
    return label(view.effective);
  };
  const libraryRole = (role: GrantRole) => t(`control:libraries.role.${role}`);
  // The empty choice: nothing given here — which, for someone with a group or the
  // household behind them, means "whatever those give".
  const noDirectLabel = (view: GrantView) => (view.inherited.some((g) => g.role !== "deny")
    ? t("controlAdmin:access.libraries.sameAsGroups")
    : t("controlAdmin:access.libraries.noAccess"));
  return { gets, libraryRole, noDirectLabel };
}

export function LibrariesTab({ state, isUser }: { state: AccessSubjectState; isUser: boolean }) {
  const { t } = useTranslation(["controlAdmin"]);
  const { overview, busy, write, base, body, del } = state;
  const { gets, libraryRole, noDirectLabel } = useGrantWords(isUser);
  if (!overview) return null;
  const name = overview.subject.name;
  return (
    <div className="access-rows">
      <p className="access-muted access-intro">{isUser ? t("controlAdmin:access.libraries.intro", { name }) : t("controlAdmin:access.libraries.introGroup", { name })}</p>
      {overview.libraries.map((library) => (
        <div className="access-row access-row-choice" key={library.id}>
          <span className="access-row-name">
            {library.name}
            <small>{t(`controlAdmin:access.libraryTypes.${library.type as "audiobook"}`, { defaultValue: library.type })}{gets(library, libraryRole) && ` · ${gets(library, libraryRole)}`}</small>
          </span>
          <SelectField
            label={t("controlAdmin:access.libraries.directFor", { library: library.name })}
            hideLabel
            compact
            value={library.direct ?? ""}
            disabled={busy}
            onChange={(role) => void write(() => (role
              ? api(`/api/library/libraries/${library.id}/members`, body({ role }))
              : api(`/api/library/libraries/${library.id}/members/${base}`, del)))}
            options={[{ value: "", label: noDirectLabel(library) }, ...LIBRARY_ROLES.map((role) => ({ value: role, label: libraryRole(role) }))]}
          />
        </div>
      ))}
      {overview.inbox && (
        <div className="access-row access-row-choice">
          <span className="access-row-name">
            {t("controlAdmin:access.family.inbox")}
            <small>{[t("controlAdmin:access.libraries.inboxKind"), ...overview.inbox.inherited.filter((g) => g.via === "group").map((g) => t("controlAdmin:access.fromGroup", { group: g.groupName ?? "" }))].join(" · ")}</small>
          </span>
          <SelectField
            label={t("controlAdmin:access.family.inboxReviewer")}
            hideLabel
            compact
            value={inboxLevel(overview.inbox)}
            disabled={busy}
            onChange={(level) => void write(() => (level
              ? api("/api/storage/app-storage/parts/inbox/reviewers", body({ level }))
              : api(`/api/storage/app-storage/parts/inbox/reviewers/${base}`, del)))}
            options={[
              { value: "", label: t("controlAdmin:access.family.notReviewer") },
              { value: "details", label: t("controlAdmin:appStorage.reviewers.levels.details") },
              { value: "keep", label: t("controlAdmin:appStorage.reviewers.levels.keep") }
            ]}
          />
        </div>
      )}
    </div>
  );
}

/** The Inbox reviewer choice as the select's value: "" · "details" · "keep". */
export function inboxLevel(inbox: GrantView): "" | "details" | "keep" {
  return inbox.direct === "manager" ? "keep" : inbox.direct === "contributor" ? "details" : "";
}

export function FamilyTab({ state, isUser }: { state: AccessSubjectState; isUser: boolean }) {
  const { t } = useTranslation(["controlAdmin", "family", "stories"]);
  const { overview, people, busy, write, base, body, del } = state;
  const { gets, noDirectLabel } = useGrantWords(isUser);
  if (!overview) return null;
  const collectionRole = (role: GrantRole) => t(`stories:collections.roles.${role === "member" ? "viewer" : role}`);
  return (
    <div className="access-rows">
      <h3 className="access-section-title">{t("controlAdmin:access.family.tree")}</h3>
      <div className="access-row access-row-choice">
        <span className="access-row-name">
          {t("controlAdmin:access.family.seeTree")}
          {overview.tree.blockedBy.length > 0
            ? <small>{t("controlAdmin:access.family.blockedBy", { names: overview.tree.blockedBy.map((n) => n ?? t("controlAdmin:access.family.everyone")).join(", ") })}</small>
            : isUser && <small>{overview.tree.canSee ? t("controlAdmin:access.family.seesIt") : t("controlAdmin:access.blocked")}</small>}
        </span>
        <SelectField
          label={t("controlAdmin:access.family.seeTree")}
          hideLabel
          compact
          value={overview.tree.blocked ? "no" : "yes"}
          disabled={busy}
          onChange={(value) => void write(() => api(`/api/family-tree/viewers/${base}`, { method: "PUT", body: JSON.stringify({ canSee: value === "yes" }) }))}
          options={[
            { value: "yes", label: t("controlAdmin:access.family.canSee") },
            { value: "no", label: t("controlAdmin:access.family.cannotSee") }
          ]}
        />
      </div>
      {people && (
        <label className="access-toggle">
          <input
            type="checkbox"
            checked={people.settings.showLivingDetails}
            disabled={busy}
            onChange={(event) => { const on = event.target.checked; void write(() => api(`/api/family-tree/viewers/${base}`, { method: "PUT", body: JSON.stringify({ showLivingDetails: on }) })); }}
          />
          <span>
            {t("controlAdmin:access.family.living")}
            <small>{t("controlAdmin:access.family.livingHint")}</small>
            {isUser && overview.tree.seesLivingDetails && !people.settings.showLivingDetails && <small>{t("controlAdmin:access.family.livingViaGroup")}</small>}
          </span>
        </label>
      )}

      <h3 className="access-section-title">{t("controlAdmin:access.family.branches")}</h3>
      {overview.branches.length === 0 && <p className="access-muted">{t("controlAdmin:access.family.noBranches")}</p>}
      {overview.branches.map((branch) => (
        <div className="access-row access-row-choice" key={branch.id}>
          <span className="access-row-name">
            {branch.name}
            <small>{[
              t("family:common.counts.person", { count: branch.people }),
              ...branch.inherited.filter((g) => g.via === "group").map((g) => t("controlAdmin:access.viaGroup", { role: g.role === "deny" ? t("family:tagAccess.roleBlocked") : t("family:tagAccess.roleEditor"), group: g.groupName ?? "" }))
            ].join(" · ")}</small>
          </span>
          <SelectField
            label={t("controlAdmin:access.family.branchFor", { branch: branch.name })}
            hideLabel
            compact
            value={branch.direct ?? ""}
            disabled={busy}
            onChange={(role) => void write(() => (role
              ? api(`/api/family-tree/tags/${branch.id}/editors`, body({ role }))
              : api(`/api/family-tree/tags/${branch.id}/editors/${base}`, del)))}
            options={[
              { value: "", label: t("controlAdmin:access.family.cannotEdit") },
              { value: "contributor", label: t("family:tagAccess.roleEditor") },
              { value: "deny", label: t("family:tagAccess.roleBlocked") }
            ]}
          />
        </div>
      ))}

      <h3 className="access-section-title">{t("controlAdmin:access.family.collections")}</h3>
      {overview.collections.length === 0 && <p className="access-muted">{t("controlAdmin:access.family.noCollections")}</p>}
      {overview.collections.map((collection) => (
        <div className="access-row access-row-choice" key={collection.id}>
          <span className="access-row-name">
            {collection.name}
            {gets(collection, collectionRole) && <small>{gets(collection, collectionRole)}</small>}
          </span>
          <SelectField
            label={t("controlAdmin:access.family.collectionFor", { collection: collection.name })}
            hideLabel
            compact
            value={collection.direct ?? ""}
            disabled={busy}
            onChange={(role) => void write(() => (role
              ? api(`/api/stories/collections/${collection.id}/access`, body({ role }))
              : api(`/api/stories/collections/${collection.id}/access/${base}`, del)))}
            options={[{ value: "", label: noDirectLabel(collection) }, ...COLLECTION_ROLES.map((role) => ({ value: role, label: t(`stories:collections.roles.${role}`) }))]}
          />
        </div>
      ))}
    </div>
  );
}

export function SharedTab({ state }: { state: AccessSubjectState }) {
  const { t } = useTranslation(["controlAdmin"]);
  const { overview, busy, write, del } = state;
  if (!overview) return null;
  const name = overview.subject.name;
  return (
    <div className="access-rows">
      {overview.shares.length === 0 && (
        <div className="access-empty">
          <strong>{t("controlAdmin:access.shared.emptyTitle", { name })}</strong>
          <p className="access-muted">{t("controlAdmin:access.shared.emptyBody", { name })}</p>
        </div>
      )}
      {overview.shares.map((share) => (
        <div className="access-row access-row-two" key={share.id}>
          <span className="access-row-name">
            {t(`controlAdmin:access.shared.kinds.${share.module as "gallery_album"}`, { defaultValue: share.module })} · {share.title ?? t("controlAdmin:access.shared.untitled")}
            <small>{share.from ? t("controlAdmin:access.shared.from", { name: share.from, date: new Date(share.createdAt).toLocaleDateString() }) : new Date(share.createdAt).toLocaleDateString()}</small>
          </span>
          <Button variant="secondary" compact disabled={busy} onClick={() => void write(() => api(`/api/shares/user/${share.id}`, del))}>
            {t("controlAdmin:access.remove")}
          </Button>
        </div>
      ))}
    </div>
  );
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

export function MembersTab({ members, busy, onAdd, onRemove }: {
  members: { id: string; name: string; email: string }[];
  busy: boolean;
  onAdd: (userId: string) => void;
  onRemove: (userId: string) => void;
}) {
  const { t } = useTranslation(["controlAdmin"]);
  const [all, setAll] = useState<{ id: string; displayName: string }[]>([]);
  useEffect(() => {
    api<{ users: { id: string; displayName: string }[] }>("/api/users").then((payload) => setAll(payload.users)).catch(() => setAll([]));
  }, []);
  const inGroup = new Set(members.map((member) => member.id));
  const addable = all.filter((user) => !inGroup.has(user.id));
  return (
    <div className="access-rows">
      <p className="access-muted access-intro">{t("controlAdmin:access.members.hint")}</p>
      {members.length === 0 && <p className="access-muted">{t("controlAdmin:access.members.none")}</p>}
      {members.map((member) => (
        <div className="access-row access-row-two" key={member.id}>
          <span className="access-row-name">{member.name}<small>{member.email}</small></span>
          <Button variant="secondary" compact disabled={busy} onClick={() => onRemove(member.id)}>{t("controlAdmin:access.remove")}</Button>
        </div>
      ))}
      {addable.length > 0 && (
        <div className="access-add">
          <SelectField
            label={t("controlAdmin:access.members.add")}
            value=""
            disabled={busy}
            onChange={(userId) => { if (userId) onAdd(userId); }}
            options={[{ value: "", label: t("controlAdmin:access.members.choose") }, ...addable.map((user) => ({ value: user.id, label: user.displayName }))]}
          />
        </div>
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

export function PhotosTab({ state, isUser, onReview, onOpenAccount, onOpenGroup }: {
  state: AccessSubjectState;
  isUser: boolean;
  onReview: (person: { id: string; name: string }) => void;
  /** Their face is chosen on Account; this goes there. */
  onOpenAccount: () => void;
  onOpenGroup: (groupId: string) => void;
}) {
  const { t } = useTranslation(["controlAdmin"]);
  const { overview, people, busy, write, base, del } = state;
  const [all, setAll] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    api<{ people: { id: string; name: string }[] }>("/api/library/gallery/people")
      .then((payload) => setAll(payload.people.filter((person) => person.name.trim())))
      .catch(() => setAll([]));
  }, []);
  if (!overview || !people) return null;
  const subjectName = overview.subject.name;
  const onGrantBranch = (branchId: string) => void write(() => api(`/api/library/gallery/branches/${encodeURIComponent(branchId)}/sharing/${base}`, { method: "PUT" }));
  const onRevokeBranch = (branchId: string) => void write(() => api(`/api/library/gallery/branches/${encodeURIComponent(branchId)}/sharing/${base}`, del));
  const onSelf = (personId: string | null, showPhotos: boolean) => void write(() => api(`/api/library/gallery/access/${base}/self`, { method: "PUT", body: JSON.stringify({ personId, showPhotos }) }));
  const onGrant = (personId: string) => void write(() => api(`/api/library/gallery/people/${personId}/sharing/${base}`, { method: "PUT" }));
  const onRevoke = (personId: string) => void write(() => api(`/api/library/gallery/people/${personId}/sharing/${base}`, del));
  const onLocation = (on: boolean) => void write(() => api(`/api/library/gallery/access/${base}/settings`, { method: "PUT", body: JSON.stringify({ showLocation: on }) }));

  const direct = new Set(people.people.filter((p) => p.direct).map((p) => p.id));
  const addable = all.filter((person) => !direct.has(person.id));
  const excluded = people.people.reduce((sum, p) => sum + p.counts.excluded, 0);
  const self = people.self ?? null;
  // Their own person, when seen only as themselves, sits under the checkbox that
  // shows it; granted as well, it stays in the list with a "themselves" note.
  const selfRow = people.people.find((p) => p.self && !p.direct && p.viaGroups.length === 0) ?? null;
  const others = people.people.filter((p) => p !== selfRow);
  const directBranches = new Set(people.branches.filter((b) => b.direct).map((b) => b.id));
  const addableBranches = people.allBranches.filter((b) => !directBranches.has(b.id));
  // One person's row: their photos, Review, and Remove for a direct grant.
  const row = (person: PeopleAccess["people"][number]) => (
    <div className="access-row access-row-people" key={person.id}>
      <span className="access-row-name">
        {person.name}
        {person.self && person !== selfRow && <small>{t("controlAdmin:access.photos.selfBadge")}</small>}
        {person.viaGroups.length > 0 && (
          <small>
            {person.viaGroups.map((group) => (
              <Button key={group.id} variant="text" compact onClick={() => onOpenGroup(group.id)}>
                {t("controlAdmin:access.photos.viaGroup", { group: group.name })}
              </Button>
            ))}
          </small>
        )}
      </span>
      <span className="access-gets">{t("controlAdmin:access.photos.count", { count: person.counts.shared })}</span>
      {person.counts.toReview > 0
        ? <Button variant="secondary" compact className="access-review" disabled={busy} onClick={() => onReview(person)}>{t("controlAdmin:access.photos.review", { count: person.counts.toReview })}</Button>
        : <span className="access-muted">{t("controlAdmin:access.photos.allConfirmed")}</span>}
      {person.direct
        ? <Button variant="secondary" compact disabled={busy} onClick={() => onRevoke(person.id)}>{t("controlAdmin:access.remove")}</Button>
        : <span />}
    </div>
  );
  return (
    <div className="access-rows">
      {isUser && (
        <>
          <h3 className="access-section-title">{t("controlAdmin:access.photos.selfTitle", { name: subjectName })}</h3>
          <label className="access-toggle access-toggle-first">
            <input type="checkbox" checked={self?.showPhotos ?? false} disabled={busy || !self} onChange={(event) => self && onSelf(self.personId, event.target.checked)} />
            <span>
              {t("controlAdmin:access.photos.selfShow")}
              <small>{self ? t("controlAdmin:access.photos.selfHintLinked", { name: subjectName, face: self.name }) : t("controlAdmin:access.photos.selfHintUnlinked", { name: subjectName })}</small>
            </span>
          </label>
          {!self && (
            <div className="access-toggle-action">
              <Button variant="text" compact onClick={onOpenAccount}>{t("controlAdmin:access.photos.selfLinkOnAccount")}</Button>
            </div>
          )}
          {selfRow && row(selfRow)}
          <h3 className="access-section-title">{t("controlAdmin:access.photos.othersTitle")}</h3>
        </>
      )}
      <p className="access-muted">{t("controlAdmin:access.photos.hint", { name: subjectName })}</p>
      {others.length === 0 && <p className="access-muted">{t("controlAdmin:access.photos.none")}</p>}
      {others.map(row)}
      {addable.length > 0 && (
        <div className="access-add">
          <SelectField
            label={t("controlAdmin:access.photos.add")}
            value=""
            disabled={busy}
            onChange={(personId) => { if (personId) onGrant(personId); }}
            options={[{ value: "", label: t("controlAdmin:access.photos.choose") }, ...addable.map((person) => ({ value: person.id, label: person.name }))]}
          />
        </div>
      )}
      {people.allBranches.length > 0 && (
        <>
          <h3 className="access-section-title">{t("controlAdmin:access.photos.branchesTitle")}</h3>
          <p className="access-muted">{t("controlAdmin:access.photos.branchesHint", { name: subjectName })}</p>
          {people.branches.map((branch) => (
            <div className="access-row access-row-people" key={branch.id}>
              <span className="access-row-name">
                {branch.name}
                {branch.viaGroups.length > 0 && (
                  <small>
                    {branch.viaGroups.map((group) => (
                      <Button key={group.id} variant="text" compact onClick={() => onOpenGroup(group.id)}>
                        {t("controlAdmin:access.photos.viaGroup", { group: group.name })}
                      </Button>
                    ))}
                  </small>
                )}
              </span>
              <span className="access-gets">{t("controlAdmin:access.photos.branchPeople", { count: branch.people })}</span>
              <span className="access-gets">{t("controlAdmin:access.photos.count", { count: branch.photos })}</span>
              {branch.direct
                ? <Button variant="secondary" compact disabled={busy} onClick={() => onRevokeBranch(branch.id)}>{t("controlAdmin:access.remove")}</Button>
                : <span />}
            </div>
          ))}
          {addableBranches.length > 0 && (
            <div className="access-add">
              <SelectField
                label={t("controlAdmin:access.photos.addBranch")}
                value=""
                disabled={busy}
                onChange={(branchId) => { if (branchId) onGrantBranch(branchId); }}
                options={[{ value: "", label: t("controlAdmin:access.photos.chooseBranch") }, ...addableBranches.map((branch) => ({ value: branch.id, label: branch.name }))]}
              />
            </div>
          )}
        </>
      )}
      <label className="access-toggle">
        <input type="checkbox" checked={people.settings.showLocation} disabled={busy} onChange={(event) => onLocation(event.target.checked)} />
        <span>
          {t("controlAdmin:access.photos.location")}
          <small>{t("controlAdmin:access.photos.locationHint")}</small>
        </span>
      </label>
      <p className="access-muted">
        {t("controlAdmin:access.photos.total", { count: people.photoCount, name: subjectName })}
        {excluded > 0 && ` · ${t("controlAdmin:access.photos.excluded", { count: excluded })}`}
      </p>
    </div>
  );
}
