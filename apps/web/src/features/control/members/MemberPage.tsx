import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ArrowLeft, Clock, Eye, KeyRound, Save, Share2, Shield, Trash2, UserRound, UsersRound } from "lucide-react";
import { api, type PublicUser } from "../../../api";
import { controlHref, followRoute, memberHref, navigate, type MemberPageTab } from "../../../router";
import { Button } from "../../../shared/Button";
import { ActionMenu } from "../../../shared/ActionMenu";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { SelectField } from "../../../shared/SelectField";
import { avatarHue, avatarInitials, formatManagedDate } from "../../../shared/utils";
import { clearCachedUser } from "../../../offline/downloads";
import type { LogEvent, ManagedUser } from "../types";
import { groupAccessHref, logsHref } from "../links";
import { PeopleReviewModal } from "../access/PeopleReviewModal";
import { GroupChips, WhoTheyAre, editsBranchWords, groupGives, inboxLevel, useAccessSubject } from "../access/AccessTabs";
import { useUserActions } from "./useUserActions";
import { MemberLibrariesTab } from "./MemberLibrariesTab";
import { MemberPhotosTab } from "./MemberPhotosTab";
import { MemberFamilyTab } from "./MemberFamilyTab";
import { MemberSharedTab } from "./MemberSharedTab";

// One member, one page: Members › Users › <name>. The header carries who they
// are and the things done to the account (Preview as, the ⋮ menu, Save); the
// tabs are real addresses (memberHref). Account is the profile and the summary
// of everything the other tabs give; those tabs are the same rows a group's
// Access dialog shows (access/AccessTabs).
//
// Two ways of saving: the profile (name, email, role) waits for Save changes,
// like every edit form; access — groups, who they are, libraries, people, the
// tree — saves as each choice is made, since each one is its own grant.

type UserRole = "admin" | "member";
const TABS: MemberPageTab[] = ["account", "libraries", "photos", "family", "stories", "shared"];

export function MemberPage({ userId, tab, currentUser }: { userId: string; tab: MemberPageTab; currentUser: PublicUser }) {
  const { t } = useTranslation(["common", "controlAdmin", "control"]);
  const subject = useMemo(() => ({ subjectType: "user" as const, subjectId: userId }), [userId]);
  const state = useAccessSubject(subject);
  const { overview, people, error, setError, busy, setBusy, write, base, reload } = state;

  // The account row the Users list has: what the ⋮ menu and the status need.
  const [account, setAccount] = useState<ManagedUser | null>(null);
  const [missing, setMissing] = useState(false);
  const loadAccount = useCallback(async () => {
    const payload = await api<{ users: ManagedUser[] }>("/api/users");
    const found = payload.users.find((user) => user.id === userId) ?? null;
    setAccount(found);
    setMissing(!found);
  }, [userId]);
  useEffect(() => {
    loadAccount().catch((err) => setError(err instanceof Error ? err.message : t("controlAdmin:users.loadFailed")));
  }, [loadAccount, setError, t]);

  // The profile form, seeded once the account is known; Save goes quiet until the
  // next edit, since what was saved is the new baseline.
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<UserRole>("member");
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");
  useEffect(() => {
    if (!account || seededFor === account.id) return;
    setDisplayName(account.displayName);
    setEmail(account.email);
    setRole(account.role);
    setSeededFor(account.id);
  }, [account, seededFor]);

  const dirty = Boolean(account) && (displayName.trim() !== account!.displayName || email.trim() !== account!.email || role !== account!.role);
  const canSave = dirty && Boolean(displayName.trim() && email.trim());
  const roleLocked = account ? account.protectedFromDelete || account.id === currentUser.id : false;

  const saveProfile = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!account || !canSave || saving) return;
    setSaving(true);
    setSaveError("");
    setSaved(false);
    try {
      await api(`/api/users/${account.id}`, {
        method: "PATCH",
        body: JSON.stringify({ displayName, email, role })
      });
      // The header and the access overview both carry the name: read them again.
      await Promise.all([loadAccount(), reload()]);
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("controlAdmin:users.saveUserFailed"));
    } finally {
      setSaving(false);
    }
  };

  const actions = useUserActions({
    currentUserId: currentUser.id,
    onChanged: loadAccount,
    onDeleted: () => navigate(controlHref("users")),
    onError: setError
  });

  // "Preview as …" (server: core/preview.ts): the whole app as this member,
  // read-only, until Stop. A full load, so every screen starts as them.
  const startPreview = async () => {
    setBusy(true);
    setError("");
    try {
      await api("/api/preview", { method: "POST", body: JSON.stringify({ userId }) });
      clearCachedUser();
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:access.errors.preview"));
      setBusy(false);
    }
  };

  const [reviewing, setReviewing] = useState<{ id: string; name: string } | null>(null);
  const del = { method: "DELETE" };
  const name = account?.displayName ?? overview?.subject.name ?? "";

  const tabLabel = (id: MemberPageTab): string => {
    switch (id) {
      case "account": return t("controlAdmin:access.tabs.account");
      case "libraries": return t("controlAdmin:access.tabs.libraries");
      case "photos": return t("controlAdmin:access.tabs.photos");
      case "family": return t("controlAdmin:access.family.tree");
      case "stories": return t("controlAdmin:access.family.collections");
      case "shared": return t("controlAdmin:access.tabs.sharedWith");
    }
  };

  const usersHref = controlHref("users");

  return (
    <div className="member-page">
      <div className="member-page-head">
        <a className="text-button member-page-back" href={usersHref} onClick={(event) => followRoute(event, usersHref)}>
          <ArrowLeft size={15} aria-hidden="true" />
          {t("controlAdmin:member.backToUsers")}
        </a>
        <div className="member-page-title-row">
          <div className="member-page-identity">
            <span className="member-page-avatar" aria-hidden="true" style={{ background: `hsl(${avatarHue(name)}, 58%, 52%)` }}>
              {name ? avatarInitials(name) : <UserRound size={28} />}
            </span>
            <div className="member-page-copy">
              <h1>{name || t("controlAdmin:access.loading")}</h1>
              {account && (
                <p className="member-page-subtitle">
                  <span>{account.email}</span>
                  <span aria-hidden="true">·</span>
                  <span>{account.role === "admin" ? t("controlAdmin:users.roleAdmin") : t("controlAdmin:users.roleMember")}</span>
                  <span className={`status-badge ${account.isActive ? "active" : "idle"}`}>
                    {account.isActive ? t("controlAdmin:member.statusActive") : t("controlAdmin:member.statusDeactivated")}
                  </span>
                  {account.id === currentUser.id && <span className="status-badge current">{t("controlAdmin:users.badgeCurrent")}</span>}
                  {account.protectedFromDelete && <span className="status-badge protected">{t("controlAdmin:users.badgeProtected")}</span>}
                  {account.locked && <span className="status-badge locked">{t("controlAdmin:users.badgeLocked")}</span>}
                </p>
              )}
            </div>
          </div>
          {account && (
            <div className="member-page-actions">
              {account.role === "member" && account.isActive && (
                <Button variant="secondary" disabled={busy} onClick={() => void startPreview()}>
                  <Eye size={15} aria-hidden="true" />
                  {t("controlAdmin:access.previewAs", { name })}
                </Button>
              )}
              <ActionMenu
                trigger="icon"
                label={t("controlAdmin:users.manageAria", { name })}
                items={actions.menuItems(account, { withDelete: false })}
              />
              <Button variant="primary" onClick={() => void saveProfile()} disabled={!canSave || saving || busy}>
                <Save size={16} aria-hidden="true" />
                <span>{saving ? t("control:ui.saving") : t("control:ui.saveChanges")}</span>
              </Button>
            </div>
          )}
        </div>
      </div>

      <div className="control-tabs member-page-tabs" role="tablist" aria-label={t("controlAdmin:member.tabsAria", { name })}>
        {TABS.map((id) => {
          const href = memberHref(userId, id);
          const active = id === tab;
          return (
            <a key={id} role="tab" aria-selected={active} className={active ? "active" : undefined} href={href} onClick={(event) => followRoute(event, href)}>
              {tabLabel(id)}
            </a>
          );
        })}
      </div>

      {error && <MessageBox tone="error" title={t("controlAdmin:access.errors.title")}>{error}</MessageBox>}
      {missing && <MessageBox tone="warning" title={t("controlAdmin:member.notFoundTitle")}>{t("controlAdmin:member.notFoundBody")}</MessageBox>}
      {!overview && !error && !missing && <p className="access-muted">{t("controlAdmin:access.loading")}</p>}

      {tab === "account" && account && overview && people && (
        <div className="member-page-grid">
          <div className="member-page-column">
            {/* First: how far their access reaches, each tile the way to the tab that sets it. */}
            <AccessSummary state={state} userId={userId} />

            <section className="member-card" aria-labelledby="member-profile-title">
              <h2 id="member-profile-title">{t("controlAdmin:access.account.profile")}</h2>
              <form className="access-profile-grid" onSubmit={saveProfile}>
                <Field label={t("controlAdmin:users.displayName")} value={displayName} onChange={(value) => { setDisplayName(value); setSaved(false); }} autoComplete="name" />
                <Field label={t("common.email")} type="email" value={email} onChange={(value) => { setEmail(value); setSaved(false); }} autoComplete="email" />
                <SelectField
                  label={t("controlAdmin:users.role")}
                  icon={<Shield size={17} />}
                  value={role}
                  disabled={roleLocked}
                  onChange={(value) => { setRole(value as UserRole); setSaved(false); }}
                  options={[
                    { value: "member", label: t("controlAdmin:users.roleMember") },
                    { value: "admin", label: t("controlAdmin:users.roleAdmin") }
                  ]}
                />
                <div className="field member-status-field">
                  <span>{t("controlAdmin:member.status")}</span>
                  <div className="member-status-value">
                    <span className={`status-badge ${account.isActive ? "active" : "idle"}`}>
                      {account.isActive ? t("controlAdmin:member.statusActive") : t("controlAdmin:member.statusDeactivated")}
                    </span>
                    <small>{t("controlAdmin:member.memberSince", { date: formatManagedDate(account.createdAt) })}</small>
                  </div>
                </div>
                {/* Enter in a field saves, as the header button does. */}
                <Button variant="bare" type="submit" hidden aria-hidden="true" tabIndex={-1} />
                {roleLocked && (
                  <MessageBox tone="info" title={t("controlAdmin:users.roleLockedTitle")}>{t("controlAdmin:users.roleLockedBody")}</MessageBox>
                )}
                {saveError && <MessageBox tone="error" title={t("controlAdmin:users.saveUserFailed")}>{saveError}</MessageBox>}
                {saved && !saveError && <MessageBox tone="success" title={t("controlAdmin:access.saved")}>{t("controlAdmin:access.savedBody")}</MessageBox>}
              </form>
              <p className="member-card-note">{t("controlAdmin:member.profileNote")}</p>
            </section>

            <section className="member-card" aria-labelledby="member-groups-title">
              <h2 id="member-groups-title">{t("controlAdmin:access.groups.title")}</h2>
              <p className="access-muted">{t("controlAdmin:access.groups.hint")}</p>
              <GroupChips
                overview={overview}
                busy={busy}
                onAdd={(groupId) => void write(() => api(`/api/groups/${groupId}/members`, { method: "POST", body: JSON.stringify({ userId }) }))}
                onRemove={(groupId) => void write(() => api(`/api/groups/${groupId}/members/${encodeURIComponent(userId)}`, del))}
              />
            </section>

            <section className="member-card" aria-labelledby="member-who-title">
              <h2 id="member-who-title">{t("controlAdmin:access.who.title", { name })}</h2>
              <p className="access-muted">{t("controlAdmin:access.who.hint")}</p>
              <WhoTheyAre
                me={overview.tree.me ?? null}
                face={people.self ?? null}
                busy={busy}
                onTreePerson={(personId, galleryPersonId) => void write(async () => {
                  await api(`/api/family-tree/users/${encodeURIComponent(userId)}/person`, { method: "PUT", body: JSON.stringify({ personId }) });
                  // Their face follows their tree person when none is set yet —
                  // the link alone grants nothing, so it is safe to fill in.
                  if (personId && galleryPersonId && !people.self) {
                    await api(`/api/library/gallery/access/${base}/self`, { method: "PUT", body: JSON.stringify({ personId: galleryPersonId, showPhotos: false }) });
                  }
                })}
                onFace={(personId) => void write(() => api(`/api/library/gallery/access/${base}/self`, { method: "PUT", body: JSON.stringify({ personId, showPhotos: personId ? people.self?.showPhotos ?? false : false }) }))}
              />
            </section>

          </div>

          <div className="member-page-column">
            <RecentActivity userId={userId} />
            <EffectivePermissions state={state} />

            <section className="member-card member-card-danger" aria-labelledby="member-danger-title">
              <h2 id="member-danger-title">
                <AlertTriangle size={17} aria-hidden="true" />
                {t("controlAdmin:member.dangerTitle")}
              </h2>
              <p className="access-muted">{t("controlAdmin:member.dangerBody")}</p>
              <div className="member-danger-actions">
                <Button
                  variant="danger"
                  disabled={busy || !actions.canDelete(account)}
                  title={actions.canDelete(account) ? undefined : t("controlAdmin:users.cannotDelete")}
                  onClick={() => actions.askDelete(account)}
                >
                  <Trash2 size={15} aria-hidden="true" />
                  {t("controlAdmin:member.deleteAccount")}
                </Button>
                {!actions.canDelete(account) && <small className="access-muted">{t("controlAdmin:users.cannotDelete")}</small>}
              </div>
            </section>
          </div>
        </div>
      )}

      {overview && tab === "libraries" && (
        <div className="member-page-grid">
          <MemberLibrariesTab state={state} name={name} />
        </div>
      )}

      {overview && tab === "photos" && (
        <div className="member-page-grid">
          <MemberPhotosTab
            state={state}
            name={name}
            onOpenAccount={() => navigate(memberHref(userId, "account"))}
            onReview={(person) => setReviewing(person)}
            onOpenGroup={(groupId) => navigate(groupAccessHref(groupId, "photos"))}
          />
        </div>
      )}

      {overview && (tab === "family" || tab === "stories") && (
        <div className="member-page-grid">
          <MemberFamilyTab state={state} part={tab === "family" ? "tree" : "stories"} />
        </div>
      )}

      {overview && tab === "shared" && (
        <div className="member-page-grid">
          <MemberSharedTab state={state} name={name} />
        </div>
      )}

      {actions.dialogs}

      {reviewing && (
        <PeopleReviewModal
          person={reviewing}
          onClose={() => setReviewing(null)}
          onDone={() => { setReviewing(null); void reload(); }}
        />
      )}
    </div>
  );
}

// Four tiles: how far their access reaches, each a link to the tab that sets it.
function AccessSummary({ state, userId }: { state: ReturnType<typeof useAccessSubject>; userId: string }) {
  const { t } = useTranslation(["controlAdmin"]);
  const { overview, people } = state;
  if (!overview || !people) return null;
  const libraries = overview.libraries.filter((library) => library.effective != null).length;
  const reach = people.people.length + people.branches.length;
  const tiles: { tab: MemberPageTab; icon: ReactNode; value: string; label: string }[] = [
    { tab: "libraries", icon: <KeyRound size={18} aria-hidden="true" />, value: String(libraries), label: t("controlAdmin:member.summary.libraries", { count: libraries }) },
    { tab: "photos", icon: <UsersRound size={18} aria-hidden="true" />, value: String(reach), label: t("controlAdmin:member.summary.people", { count: reach }) },
    { tab: "family", icon: <Shield size={18} aria-hidden="true" />, value: t("controlAdmin:access.family.tree"), label: overview.tree.canSee ? t("controlAdmin:access.family.canSee") : t("controlAdmin:access.family.cannotSee") },
    { tab: "shared", icon: <Share2 size={18} aria-hidden="true" />, value: String(overview.shares.length), label: t("controlAdmin:member.summary.shared", { count: overview.shares.length }) }
  ];
  return (
    <section className="member-card" aria-labelledby="member-summary-title">
      <h2 id="member-summary-title">{t("controlAdmin:member.summaryTitle")}</h2>
      <div className="member-summary-tiles">
        {tiles.map((tile) => {
          const href = memberHref(userId, tile.tab);
          return (
            <a key={tile.tab} className="member-summary-tile" href={href} onClick={(event) => followRoute(event, href)}>
              {tile.icon}
              <span className="member-summary-copy">
                <strong>{tile.value}</strong>
                <small>{tile.label}</small>
              </span>
            </a>
          );
        })}
      </div>
    </section>
  );
}

// The last few things they did, from the activity log, and the way to the rest.
function RecentActivity({ userId }: { userId: string }) {
  const { t } = useTranslation(["controlAdmin"]);
  const [events, setEvents] = useState<LogEvent[] | null>(null);
  useEffect(() => {
    // The log pages by ten at the least; the card shows the first five.
    api<{ events: LogEvent[] }>(`/api/logs?user=${encodeURIComponent(userId)}&pageSize=10`)
      .then((payload) => setEvents(payload.events.slice(0, 5)))
      .catch(() => setEvents([]));
  }, [userId]);
  const allHref = logsHref({ user: userId });
  return (
    <section className="member-card" aria-labelledby="member-activity-title">
      <div className="member-card-head">
        <h2 id="member-activity-title">
          <Clock size={17} aria-hidden="true" />
          {t("controlAdmin:member.activityTitle")}
        </h2>
        <a className="text-button member-card-link" href={allHref} onClick={(event) => followRoute(event, allHref)}>{t("controlAdmin:member.activityAll")}</a>
      </div>
      {events === null && <p className="access-muted">{t("controlAdmin:access.loading")}</p>}
      {events && events.length === 0 && <p className="access-muted">{t("controlAdmin:member.activityNone")}</p>}
      {events && events.length > 0 && (
        <ul className="member-activity">
          {events.map((event) => (
            <li key={event.id}>
              <span className="member-activity-when">{formatManagedDate(event.createdAt)}</span>
              <span className="member-activity-what">{event.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// Where their access comes from, source by source: each group and what it gives,
// the people whose photos they see, what was sent to them, and what was given to
// them by name. The tabs hold the controls; this is the reading.
function EffectivePermissions({ state }: { state: ReturnType<typeof useAccessSubject> }) {
  const { t } = useTranslation(["controlAdmin"]);
  const { overview, people } = state;
  if (!overview || !people) return null;
  const directLibraries = overview.libraries.filter((library) => library.direct && library.direct !== "deny").map((library) => library.name);
  const inbox = overview.inbox ? inboxLevel(overview.inbox) : "";
  const inboxWords = inbox === "keep"
    ? t("controlAdmin:appStorage.reviewers.levels.keep")
    : inbox === "details" ? t("controlAdmin:appStorage.reviewers.levels.details") : t("controlAdmin:access.family.notReviewer");
  const reach = people.people.length + people.branches.length;
  // The household baseline (the Everyone group) is not among their groups: it
  // reaches everyone, so it is listed first, by what it gives.
  const fromEveryone = overview.libraries.filter((library) => library.inherited.some((g) => g.via === "everyone" && g.role !== "deny")).map((library) => library.name);
  const rows: { key: string; icon: ReactNode; source: string; description: string }[] = [
    {
      key: "everyone",
      icon: <UsersRound size={16} aria-hidden="true" />,
      source: t("controlAdmin:member.permissions.everyone"),
      description: fromEveryone.length > 0 ? fromEveryone.join(", ") : t("controlAdmin:access.groups.givesNothing")
    },
    ...overview.groups.map((group) => ({
      key: `group-${group.id}`,
      icon: <UsersRound size={16} aria-hidden="true" />,
      source: group.name,
      description: groupGives(overview, group.id, editsBranchWords(t)) || t("controlAdmin:access.groups.givesNothing")
    })),
    {
      key: "people",
      icon: <UserRound size={16} aria-hidden="true" />,
      source: t("controlAdmin:member.permissions.people", { count: reach }),
      description: reach > 0 ? t("controlAdmin:member.permissions.peopleBody", { count: people.photoCount }) : t("controlAdmin:access.photos.none")
    },
    {
      key: "shares",
      icon: <Share2 size={16} aria-hidden="true" />,
      source: t("controlAdmin:member.permissions.shares"),
      description: t("controlAdmin:member.permissions.sharesBody", { count: overview.shares.length })
    },
    {
      key: "direct",
      icon: <KeyRound size={16} aria-hidden="true" />,
      source: t("controlAdmin:member.permissions.direct"),
      description: [
        directLibraries.length > 0 ? t("controlAdmin:member.permissions.directLibraries", { names: directLibraries.join(", ") }) : t("controlAdmin:member.permissions.directNone"),
        overview.inbox ? `${t("controlAdmin:access.family.inbox")}: ${inboxWords}` : ""
      ].filter(Boolean).join(" · ")
    }
  ];
  return (
    <section className="member-card" aria-labelledby="member-permissions-title">
      <h2 id="member-permissions-title">
        <Shield size={17} aria-hidden="true" />
        {t("controlAdmin:member.permissionsTitle")}
      </h2>
      <p className="access-muted">{t("controlAdmin:member.permissionsHint")}</p>
      <table className="member-table member-permissions">
        <thead>
          <tr>
            <th>{t("controlAdmin:member.permissions.source")}</th>
            <th>{t("controlAdmin:member.permissions.description")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td><span className="member-permissions-source">{row.icon}{row.source}</span></td>
              <td>{row.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
