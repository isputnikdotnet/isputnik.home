import { useEffect, useMemo, useState } from "react";
import { Check, KeyRound, UsersRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../../api";
import { navigate } from "../../../router";
import { Button } from "../../../shared/Button";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { groupAccessHref, userAccessHref } from "../links";
import { PeopleReviewModal } from "./PeopleReviewModal";
import { FamilyTab, GroupChips, LibrariesTab, MembersTab, PhotosTab, SharedTab, WhoTheyAre, useAccessSubject } from "./AccessTabs";
import type { AccessSubject, AccessTab, GrantView } from "./types";

// A group's access, in one dialog over the Groups list: its members first, then
// what it is given (docs/people-sharing-plan.md, phase 2, D13/D18). The tab
// bodies are shared with a member's page (members/MemberPage), which is where a
// person's access is edited since 4.24 — the dialog ran out of room for a
// profile, groups, four kinds of access and a preview. It still accepts a user
// subject, so an old caller degrades to the dialog rather than to nothing.

export function AccessDialog({
  subject,
  initialTab,
  onClose,
  onChanged
}: {
  subject: AccessSubject;
  initialTab?: AccessTab;
  onClose: () => void;
  /** Something changed that a list behind the dialog shows (membership, a role). */
  onChanged?: () => void;
}) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const isUser = subject.subjectType === "user";
  const tabs: AccessTab[] = isUser
    ? ["account", "libraries", "photos", "family", "shared"]
    : ["members", "libraries", "photos", "family"];
  // Groups used to be a tab of its own; its address now opens Account, where they are.
  const wanted = initialTab === "groups" ? "account" : initialTab;
  const [tab, setTab] = useState<AccessTab>(wanted && tabs.includes(wanted) ? wanted : tabs[0]);
  const state = useAccessSubject(subject);
  const { overview, people, error, busy, write, base, reload } = state;
  const [reviewing, setReviewing] = useState<{ id: string; name: string } | null>(null);

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

  const del = { method: "DELETE" };
  const name = overview?.subject.name ?? "";
  const summary = useMemo(() => {
    if (!overview) return "";
    const reach = (view: GrantView) => (isUser ? view.effective != null : view.direct != null && view.direct !== "deny");
    const parts: string[] = [];
    if (overview.subject.subjectType === "user") {
      return [overview.subject.role === "admin" ? t("controlAdmin:users.roleAdmin") : t("controlAdmin:users.roleMember"), overview.subject.email].join(" · ");
    }
    parts.push(t("controlAdmin:access.summary.members", { count: overview.subject.members.length }));
    parts.push(t("controlAdmin:access.summary.libraries", { count: overview.libraries.filter(reach).length }));
    if (people && people.people.length > 0) parts.push(t("controlAdmin:access.summary.people", { count: people.people.length }));
    const edits = overview.branches.filter((branch) => branch.direct === "contributor");
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

          {overview && people && tab === "account" && isUser && (
            <div className="access-sections">
              <section className="access-section">
                <h3 className="access-section-title">{t("controlAdmin:access.who.title", { name })}</h3>
                <p className="access-muted">{t("controlAdmin:access.who.hint")}</p>
                <WhoTheyAre
                  me={overview.tree.me ?? null}
                  face={people.self ?? null}
                  busy={busy}
                  onTreePerson={(personId, galleryPersonId) => void write(async () => {
                    await api(`/api/family-tree/users/${encodeURIComponent(subject.subjectId)}/person`, { method: "PUT", body: JSON.stringify({ personId }) });
                    if (personId && galleryPersonId && !people.self) {
                      await api(`/api/library/gallery/access/${base}/self`, { method: "PUT", body: JSON.stringify({ personId: galleryPersonId, showPhotos: false }) });
                    }
                  })}
                  onFace={(personId) => void write(() => api(`/api/library/gallery/access/${base}/self`, { method: "PUT", body: JSON.stringify({ personId, showPhotos: personId ? people.self?.showPhotos ?? false : false }) }))}
                />
              </section>
              <section className="access-section">
                <h3 className="access-section-title">{t("controlAdmin:access.groups.title")}</h3>
                <p className="access-muted">{t("controlAdmin:access.groups.hint")}</p>
                <GroupChips
                  overview={overview}
                  busy={busy}
                  onAdd={(groupId) => void write(() => api(`/api/groups/${groupId}/members`, { method: "POST", body: JSON.stringify({ userId: subject.subjectId }) }), onChanged)}
                  onRemove={(groupId) => void write(() => api(`/api/groups/${groupId}/members/${encodeURIComponent(subject.subjectId)}`, del), onChanged)}
                />
              </section>
            </div>
          )}

          {overview && tab === "members" && overview.subject.subjectType === "group" && (
            <MembersTab
              members={overview.subject.members}
              busy={busy}
              onAdd={(userId) => void write(() => api(`/api/groups/${subject.subjectId}/members`, { method: "POST", body: JSON.stringify({ userId }) }), onChanged)}
              onRemove={(userId) => void write(() => api(`/api/groups/${subject.subjectId}/members/${encodeURIComponent(userId)}`, del), onChanged)}
            />
          )}

          {tab === "libraries" && <LibrariesTab state={state} isUser={isUser} />}

          {tab === "photos" && (
            <PhotosTab
              state={state}
              isUser={isUser}
              onOpenAccount={() => setTab("account")}
              onReview={(person) => setReviewing(person)}
              onOpenGroup={(groupId) => { close(); navigate(groupAccessHref(groupId, "photos")); }}
            />
          )}

          {tab === "family" && <FamilyTab state={state} isUser={isUser} />}

          {tab === "shared" && <SharedTab state={state} />}
        </div>

        <div className="modal-actions access-dialog-footer">
          <span className="access-footer-note">
            <Check size={15} aria-hidden="true" />
            {t("controlAdmin:access.footer.liveNote")}
          </span>
          <Button variant="secondary" onClick={close} disabled={busy}>{t("common.close")}</Button>
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
