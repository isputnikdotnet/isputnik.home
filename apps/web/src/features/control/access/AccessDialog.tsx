import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Eye, KeyRound, Save, UsersRound, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../../api";
import { navigate } from "../../../router";
import { Button } from "../../../shared/Button";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { SelectField } from "../../../shared/SelectField";
import { groupAccessHref, userAccessHref } from "../links";
import { PeopleReviewModal } from "./PeopleReviewModal";
import { clearCachedUser } from "../../../offline/downloads";
import type { AccessOverview, AccessSubject, AccessTab, GrantRole, GrantView, PeopleAccess } from "./types";

// Everything one person — or one group — can reach, in one dialog
// (docs/people-sharing-plan.md, phase 2, D13). Each tab shows what was given
// DIRECTLY, which it can change, beside what they get from elsewhere (a group,
// the household's Everyone baseline), which it names in words instead.
// Writes go through the routes each object already has, so a library's Members
// dialog and this one always agree.
//
// Two ways of saving, said in the footer: the profile (name, email, role) waits
// for Save profile, like every edit form; access — groups, libraries, people,
// the tree — saves as each choice is made, since each one is its own grant.
// Who someone IS (their tree person and Gallery face) sits on Account with
// their groups: it describes them, and grants nothing.

const SYSTEM_GROUP_IDS = new Set(["grp-everyone", "grp-system-admins"]);
const LIBRARY_ROLES: GrantRole[] = ["viewer", "member", "contributor", "manager", "deny"];
const COLLECTION_ROLES = ["viewer", "contributor", "manager", "deny"] as const;

export function AccessDialog({
  subject,
  initialTab,
  account,
  onClose,
  onChanged
}: {
  subject: AccessSubject;
  initialTab?: AccessTab;
  /** A user's profile, on the Account tab: the Users page's fields, and the
   *  save the footer's Save profile runs. */
  account?: { fields: ReactNode; onSave: () => void; saving: boolean; canSave: boolean };
  onClose: () => void;
  /** Something changed that a list behind the dialog shows (membership, a role). */
  onChanged?: () => void;
}) {
  const { t } = useTranslation(["common", "controlAdmin", "control", "stories", "family"]);
  const isUser = subject.subjectType === "user";
  const tabs: AccessTab[] = isUser
    ? ["account", "libraries", "photos", "family", "shared"]
    : ["members", "libraries", "photos", "family"];
  // Groups used to be a tab of its own; its address now opens Account, where they are.
  const wanted = initialTab === "groups" ? "account" : initialTab;
  const [tab, setTab] = useState<AccessTab>(wanted && tabs.includes(wanted) ? wanted : tabs[0]);
  const [overview, setOverview] = useState<AccessOverview | null>(null);
  const [people, setPeople] = useState<PeopleAccess | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState<{ id: string; name: string } | null>(null);

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

  // A profile save (name, email, role) changes the header too: read it again once
  // the save has finished.
  const profileSaving = account?.saving ?? false;
  const wasSaving = useRef(false);
  useEffect(() => {
    if (wasSaving.current && !profileSaving) void reload().catch(() => undefined);
    wasSaving.current = profileSaving;
  }, [profileSaving, reload]);

  // Keep the address in step, so a reload or a pasted link opens the same tab.
  useEffect(() => {
    const href = isUser ? userAccessHref(subject.subjectId, tab) : groupAccessHref(subject.subjectId, tab);
    window.history.replaceState(window.history.state, "", href);
  }, [isUser, subject.subjectId, tab]);
  const close = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete(isUser ? "user" : "group");
    url.searchParams.delete("tab");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
    onClose();
  };

  // One write, then everything reloads: an inherited right may change with it.
  const write = async (run: () => Promise<unknown>, membership = false) => {
    setBusy(true);
    setError("");
    try {
      await run();
      await reload();
      if (membership) onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:access.errors.save"));
    } finally {
      setBusy(false);
    }
  };
  // "Preview as …" (server: core/preview.ts): the whole app as this member,
  // read-only, until Stop. A full load, so every screen starts as them.
  const startPreview = async () => {
    setBusy(true);
    setError("");
    try {
      await api("/api/preview", { method: "POST", body: JSON.stringify({ userId: subject.subjectId }) });
      clearCachedUser();
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:access.errors.preview"));
      setBusy(false);
    }
  };
  const body = (payload: object) => ({ method: "POST", body: JSON.stringify({ subjectType: subject.subjectType, subjectId: subject.subjectId, ...payload }) });
  const del = { method: "DELETE" };

  const name = overview?.subject.name ?? "";
  const summary = useMemo(() => {
    if (!overview) return "";
    const reach = (view: GrantView) => (isUser ? view.effective != null : view.direct != null && view.direct !== "deny");
    const parts: string[] = [];
    if (overview.subject.subjectType === "user") {
      // Who they are, not a tally: the tabs carry the counts.
      return [overview.subject.role === "admin" ? t("controlAdmin:users.roleAdmin") : t("controlAdmin:users.roleMember"), overview.subject.email].join(" · ");
    } else {
      parts.push(t("controlAdmin:access.summary.members", { count: overview.subject.members.length }));
    }
    parts.push(t("controlAdmin:access.summary.libraries", { count: overview.libraries.filter(reach).length }));
    if (people && people.people.length > 0) parts.push(t("controlAdmin:access.summary.people", { count: people.people.length }));
    const edits = overview.branches.filter((branch) => (isUser ? branch.direct === "contributor" || branch.inherited.some((g) => g.role === "contributor") : branch.direct === "contributor"));
    if (edits.length > 0) parts.push(t("controlAdmin:access.summary.branches", { names: edits.map((b) => b.name).join(", ") }));
    return parts.join(" · ");
  }, [overview, people, isUser, t]);

  const tabLabel = (id: AccessTab): string => {
    switch (id) {
      case "account": return t("controlAdmin:access.tabs.account");
      case "members": return t("controlAdmin:access.tabs.members", { count: overview?.subject.subjectType === "group" ? overview.subject.members.length : 0 });
      case "groups": return t("controlAdmin:access.tabs.groups", { count: overview?.groups.length ?? 0 });
      case "libraries": return t("controlAdmin:access.tabs.libraries");
      case "photos": {
        const reach = (people?.people.length ?? 0) + (people?.branches.length ?? 0);
        return reach > 0 ? t("controlAdmin:access.tabs.photosPeople", { count: reach }) : t("controlAdmin:access.tabs.photos");
      }
      case "family": return t("controlAdmin:access.tabs.family");
      case "shared": return overview && overview.shares.length > 0
        ? t("controlAdmin:access.tabs.sharedWithCount", { count: overview.shares.length })
        : t("controlAdmin:access.tabs.sharedWith");
    }
  };

  // "What they get" — the role and where it comes from.
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

  return (
    <>
      <Modal
        variant="panel"
        title={name || t("controlAdmin:access.loading")}
        subtitle={summary}
        icon={isUser ? <KeyRound size={20} /> : <UsersRound size={20} />}
        className="access-dialog"
        busy={busy}
        onClose={close}
        headerAction={overview?.subject.subjectType === "user" && overview.subject.role === "member" && overview.subject.isActive ? (
          <Button variant="secondary" compact disabled={busy} onClick={() => void startPreview()}>
            <Eye size={15} aria-hidden="true" />
            {t("controlAdmin:access.previewAs", { name })}
          </Button>
        ) : undefined}
      >
        <div className="modal-tabs" role="tablist">
          {tabs.map((id) => (
            <Button variant="tab" key={id} className="modal-tab" selected={tab === id} onClick={() => setTab(id)}>
              {tabLabel(id)}
            </Button>
          ))}
        </div>

        <div className="modal-tab-content access-dialog-content">
          {error && <MessageBox tone="error" title={t("controlAdmin:access.errors.title")}>{error}</MessageBox>}
          {!overview && !error && <p className="access-muted">{t("controlAdmin:access.loading")}</p>}

          {tab === "account" && (
            <div className="access-sections">
              {account && (
                <section className="access-section">
                  <h3 className="access-section-title">{t("controlAdmin:access.account.profile")}</h3>
                  {account.fields}
                </section>
              )}
              {overview && people && isUser && (
                <WhoTheyAre
                  subjectName={name}
                  me={overview.tree.me ?? null}
                  face={people.self ?? null}
                  busy={busy}
                  onTreePerson={(personId, galleryPersonId) => void write(async () => {
                    await api(`/api/family-tree/users/${encodeURIComponent(subject.subjectId)}/person`, { method: "PUT", body: JSON.stringify({ personId }) });
                    // Their face follows their tree person when none is set yet —
                    // the link alone grants nothing, so it is safe to fill in.
                    if (personId && galleryPersonId && !people.self) {
                      await api(`/api/library/gallery/access/${base}/self`, { method: "PUT", body: JSON.stringify({ personId: galleryPersonId, showPhotos: false }) });
                    }
                  })}
                  onFace={(personId) => void write(() => api(`/api/library/gallery/access/${base}/self`, { method: "PUT", body: JSON.stringify({ personId, showPhotos: personId ? people.self?.showPhotos ?? false : false }) }))}
                />
              )}
              {overview && isUser && (
                <GroupsSection
                  overview={overview}
                  busy={busy}
                  onAdd={(groupId) => void write(() => api(`/api/groups/${groupId}/members`, { method: "POST", body: JSON.stringify({ userId: subject.subjectId }) }), true)}
                  onRemove={(groupId) => void write(() => api(`/api/groups/${groupId}/members/${encodeURIComponent(subject.subjectId)}`, del), true)}
                />
              )}
            </div>
          )}

          {overview && tab === "members" && overview.subject.subjectType === "group" && (
            <MembersTab
              members={overview.subject.members}
              busy={busy}
              onAdd={(userId) => void write(() => api(`/api/groups/${subject.subjectId}/members`, { method: "POST", body: JSON.stringify({ userId }) }), true)}
              onRemove={(userId) => void write(() => api(`/api/groups/${subject.subjectId}/members/${encodeURIComponent(userId)}`, del), true)}
            />
          )}

          {overview && tab === "libraries" && (
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
                    value={overview.inbox.direct === "manager" ? "keep" : overview.inbox.direct === "contributor" ? "details" : ""}
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
          )}

          {overview && people && tab === "photos" && (
            <PhotosTab
              subjectName={name}
              people={people}
              isUser={isUser}
              busy={busy}
              onGrantBranch={(branchId) => void write(() => api(`/api/library/gallery/branches/${encodeURIComponent(branchId)}/sharing/${base}`, { method: "PUT" }))}
              onRevokeBranch={(branchId) => void write(() => api(`/api/library/gallery/branches/${encodeURIComponent(branchId)}/sharing/${base}`, del))}
              onSelf={(personId, showPhotos) => void write(() => api(`/api/library/gallery/access/${base}/self`, { method: "PUT", body: JSON.stringify({ personId, showPhotos }) }))}
              onOpenAccount={() => setTab("account")}
              onGrant={(personId) => void write(() => api(`/api/library/gallery/people/${personId}/sharing/${base}`, { method: "PUT" }))}
              onRevoke={(personId) => void write(() => api(`/api/library/gallery/people/${personId}/sharing/${base}`, del))}
              onReview={(person) => setReviewing(person)}
              onLocation={(on) => void write(() => api(`/api/library/gallery/access/${base}/settings`, { method: "PUT", body: JSON.stringify({ showLocation: on }) }))}
              onOpenGroup={(groupId) => { close(); navigate(groupAccessHref(groupId, "photos")); }}
            />
          )}

          {overview && tab === "family" && (
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
                    {gets(collection, (role) => t(`stories:collections.roles.${role === "member" ? "viewer" : role}`)) && (
                      <small>{gets(collection, (role) => t(`stories:collections.roles.${role === "member" ? "viewer" : role}`))}</small>
                    )}
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
          )}

          {overview && tab === "shared" && (
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
          )}
        </div>

        <div className="modal-actions access-dialog-footer">
          <span className="access-footer-note">
            <Check size={15} aria-hidden="true" />
            {tab === "account" && account ? t("controlAdmin:access.footer.accountNote") : t("controlAdmin:access.footer.liveNote")}
          </span>
          <Button variant="secondary" onClick={close} disabled={busy || account?.saving}>{t("common.close")}</Button>
          {tab === "account" && account && (
            <Button variant="primary" onClick={account.onSave} disabled={!account.canSave || account.saving || busy}>
              <Save size={16} aria-hidden="true" />
              <span>{account.saving ? t("controlAdmin:access.footer.savingProfile") : t("controlAdmin:access.footer.saveProfile")}</span>
            </Button>
          )}
        </div>
      </Modal>

      {reviewing && (
        <PeopleReviewModal
          person={reviewing}
          onClose={() => setReviewing(null)}
          onDone={() => { setReviewing(null); void reload(); }}
        />
      )}
    </>
  );
}

function GroupsSection({ overview, busy, onAdd, onRemove }: {
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
  // What each group gives, in one line — the reason it is worth being in.
  const gives = (groupId: string) => [
    ...overview.libraries.filter((l) => l.inherited.some((g) => g.groupId === groupId && g.role !== "deny")).map((l) => l.name),
    ...overview.branches.filter((b) => b.inherited.some((g) => g.groupId === groupId && g.role === "contributor")).map((b) => t("controlAdmin:access.groups.editsBranch", { branch: b.name }))
  ].join(", ");
  return (
    <section className="access-section">
      <h3 className="access-section-title">{t("controlAdmin:access.groups.title")}</h3>
      <p className="access-muted">{t("controlAdmin:access.groups.hint")}</p>
      <div className="access-chips">
        {overview.groups.length === 0 && <span className="access-muted">{t("controlAdmin:access.groups.none")}</span>}
        {overview.groups.map((group) => (
          <span className="access-chip" key={group.id} title={gives(group.id) || t("controlAdmin:access.groups.givesNothing")}>
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
    </section>
  );
}

function MembersTab({ members, busy, onAdd, onRemove }: {
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
function WhoTheyAre({ subjectName, me, face, busy, onTreePerson, onFace }: {
  subjectName: string;
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
    <section className="access-section">
      <h3 className="access-section-title">{t("controlAdmin:access.who.title", { name: subjectName })}</h3>
      <p className="access-muted">{t("controlAdmin:access.who.hint")}</p>
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
    </section>
  );
}

function PhotosTab({ subjectName, people, isUser, busy, onSelf, onOpenAccount, onGrantBranch, onRevokeBranch, onGrant, onRevoke, onReview, onLocation, onOpenGroup }: {
  subjectName: string;
  people: PeopleAccess;
  isUser: boolean;
  busy: boolean;
  /** "Show them photos of themselves" (Q1). */
  onSelf: (personId: string | null, showPhotos: boolean) => void;
  /** Their face is chosen on Account; this goes there. */
  onOpenAccount: () => void;
  /** A whole branch of the family tree (Q2). */
  onGrantBranch: (branchId: string) => void;
  onRevokeBranch: (branchId: string) => void;
  onGrant: (personId: string) => void;
  onRevoke: (personId: string) => void;
  onReview: (person: { id: string; name: string }) => void;
  onLocation: (on: boolean) => void;
  onOpenGroup: (groupId: string) => void;
}) {
  const { t } = useTranslation(["controlAdmin"]);
  const [all, setAll] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    api<{ people: { id: string; name: string }[] }>("/api/library/gallery/people")
      .then((payload) => setAll(payload.people.filter((person) => person.name.trim())))
      .catch(() => setAll([]));
  }, []);
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
