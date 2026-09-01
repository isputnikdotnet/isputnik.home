import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Globe2, Image as ImageIcon, Library, Plus, ShieldCheck, Trash2, UserRound, UsersRound } from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { goBack, navigate } from "../../router";
import { formatPartialDateRange } from "../../shared/utils";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { PhotoPicker } from "../gallery/PhotoPicker";
import { StoryCard } from "./StoryCard";
import type { StorySummary } from "./types";

interface CollectionDetail {
  id: string;
  title: string;
  description: string | null;
  coverItemId: string | null;
  coverUrl: string | null;
  canContribute: boolean;
  canManage: boolean;
  createdAt: string;
  updatedAt: string;
}

// A collection page: the shelf's hero, then its stories on a year spine —
// grouped by their own chapter dates, so the timeline is derived, never
// curated twice. "Add story" creates straight into the shelf; Access is the
// manager's door to who sees it (and through it, who sees its stories).
export function StoryCollectionPage({
  id,
  user,
  logout
}: {
  id: string;
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const [collection, setCollection] = useState<CollectionDetail | null>(null);
  const [stories, setStories] = useState<StorySummary[]>([]);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [adding, setAdding] = useState(false);
  const [pickingCover, setPickingCover] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = () => {
    api<{ collection: CollectionDetail; stories: StorySummary[] }>(`/api/stories/collections/${id}`)
      .then((payload) => {
        setCollection(payload.collection);
        setStories(payload.stories);
        setTitle(payload.collection.title);
        setDescription(payload.collection.description ?? "");
        document.title = `${payload.collection.title} — isputnik.home`;
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("stories:errors.load")));
  };
  useEffect(load, [id]);

  const patch = async (fields: Record<string, unknown>) => {
    try {
      await api(`/api/stories/collections/${id}`, { method: "PATCH", body: JSON.stringify(fields) });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("stories:errors.save"));
    }
  };

  const removeCollection = async () => {
    setDeleting(true);
    try {
      await api(`/api/stories/collections/${id}`, { method: "DELETE" });
      navigate("/stories");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("stories:errors.delete"));
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  // The year spine: stories grouped by the year their chapters start, oldest
  // year first (a shelf reads forward in time); undated stories close the page.
  const groups = useMemo(() => {
    const byYear = new Map<string, StorySummary[]>();
    const undated: StorySummary[] = [];
    for (const story of stories) {
      const year = story.firstDate?.slice(0, 4);
      if (!year) { undated.push(story); continue; }
      byYear.set(year, [...(byYear.get(year) ?? []), story]);
    }
    const dated = [...byYear.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    return { dated, undated };
  }, [stories]);

  const span = collection
    ? formatPartialDateRange(
        stories.find((story) => story.firstDate)?.firstDate ?? null,
        [...stories].map((story) => story.lastDate ?? story.firstDate).filter(Boolean).sort().pop() ?? null
      )
    : "";

  return (
    <DashboardShell active="stories" user={user} logout={logout}>
      <section className="work-area audiobook-area">
        <div className="book-detail-topbar">
          <button className="audiobook-back-button" type="button" onClick={() => goBack("/stories")}>
            <ArrowLeft size={18} aria-hidden="true" />
            <span>{t("stories:backTo")}</span>
          </button>
        </div>

        {error && <MessageBox tone="error" title={t("stories:errors.loadTitle")}>{error}</MessageBox>}
        {!collection && !error && <p className="management-empty">{t("stories:common.loading")}</p>}

        {collection && (
          <>
            <div className={`story-collection-hero${collection.coverUrl ? " has-image" : ""}`}>
              {collection.coverUrl && <img src={collection.coverUrl} alt="" />}
              <div className="story-collection-hero-text">
                <p className="eyebrow">{t("stories:collections.eyebrow")}</p>
                {collection.canManage ? (
                  <input
                    className="story-title-input"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    onBlur={() => {
                      const next = title.trim();
                      if (!next) { setTitle(collection.title); return; }
                      if (next !== collection.title) void patch({ title: next });
                    }}
                    maxLength={160}
                    aria-label={t("stories:fields.title")}
                  />
                ) : (
                  <h1>{collection.title}</h1>
                )}
                {(span || stories.length > 0) && (
                  <p className="story-collection-meta">
                    {[span, t("stories:collections.storyCount", { count: stories.length })].filter(Boolean).join(" · ")}
                  </p>
                )}
                {collection.canManage ? (
                  <textarea
                    className="story-collection-description-input"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    onBlur={() => {
                      const next = description.trim();
                      if (next !== (collection.description ?? "")) void patch({ description: next || null });
                    }}
                    placeholder={t("stories:collections.descriptionPlaceholder")}
                    rows={2}
                    maxLength={2000}
                  />
                ) : (
                  collection.description && <p className="story-collection-description">{collection.description}</p>
                )}
                <div className="story-collection-actions">
                  {collection.canContribute && (
                    <Button variant="primary" compact onClick={() => setAdding(true)}>
                      <Plus size={15} aria-hidden="true" />
                      <span>{t("stories:collections.addStory")}</span>
                    </Button>
                  )}
                  {/* The hero above shows the result, so this needs no thumb
                      of its own. Without a chosen cover the shelf card falls
                      back to a member story's photo. */}
                  {collection.canManage && (
                    <Button variant="secondary" compact onClick={() => setPickingCover(true)}>
                      <ImageIcon size={15} aria-hidden="true" />
                      <span>{collection.coverItemId ? t("stories:fields.changeCover") : t("stories:collections.setCover")}</span>
                    </Button>
                  )}
                  {collection.canManage && collection.coverItemId && (
                    <Button variant="text" compact onClick={() => void patch({ coverItemId: null })}>
                      {t("stories:fields.clearCover")}
                    </Button>
                  )}
                  {collection.canManage && (
                    <Button variant="secondary" compact onClick={() => setAccessOpen(true)}>
                      <ShieldCheck size={15} aria-hidden="true" />
                      <span>{t("stories:collections.access")}</span>
                    </Button>
                  )}
                  {collection.canManage && (
                    <Button variant="danger" compact onClick={() => setConfirmDelete(true)}>
                      <Trash2 size={15} aria-hidden="true" />
                      <span>{t("stories:actions.delete")}</span>
                    </Button>
                  )}
                </div>
              </div>
            </div>

            {stories.length === 0 && (
              <div className="empty-state library-empty">
                <Library size={58} aria-hidden="true" />
                <h2>{t("stories:collections.emptyHeading")}</h2>
                <p className="muted">{t("stories:collections.emptyBody")}</p>
              </div>
            )}

            {groups.dated.map(([year, groupStories]) => (
              <section className="story-collection-year" key={year}>
                <p className="gallery-section-label story-collection-year-label">{year}</p>
                <div className="audiobook-grid story-grid">
                  {groupStories.map((story) => <StoryCard key={story.id} story={story} />)}
                </div>
              </section>
            ))}
            {groups.undated.length > 0 && (
              <section className="story-collection-year">
                <p className="gallery-section-label story-collection-year-label">{t("stories:collections.undated")}</p>
                <div className="audiobook-grid story-grid">
                  {groups.undated.map((story) => <StoryCard key={story.id} story={story} />)}
                </div>
              </section>
            )}
          </>
        )}
      </section>

      {adding && collection && (
        <AddStoryModal collectionId={collection.id} onClose={() => setAdding(false)} />
      )}

      {pickingCover && collection && (
        <PhotoPicker
          title={t("stories:collections.coverPickerTitle")}
          pick="any"
          onPick={(asset) => { setPickingCover(false); void patch({ coverItemId: asset.id }); }}
          onClose={() => setPickingCover(false)}
        />
      )}

      {accessOpen && collection && (
        <CollectionAccessModal collectionId={collection.id} title={collection.title} onClose={() => setAccessOpen(false)} />
      )}

      {confirmDelete && collection && (
        <ConfirmDialog
          title={t("stories:collections.deleteTitle", { name: collection.title })}
          confirmLabel={t("stories:collections.deleteConfirm")}
          busyLabel={t("stories:collections.deleting")}
          danger
          busy={deleting}
          onConfirm={() => void removeCollection()}
          onCancel={() => setConfirmDelete(false)}
        >
          {t("stories:collections.deleteBody")}
        </ConfirmDialog>
      )}
    </DashboardShell>
  );
}

// "Add story" from the shelf: the story is born onto it and opens in the
// editor, the same two fields the index's New story asks for.
function AddStoryModal({ collectionId, onClose }: { collectionId: string; onClose: () => void }) {
  const { t } = useTranslation(["common", "stories"]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError("");
    try {
      const { story } = await api<{ story: { id: string } }>("/api/stories", {
        method: "POST",
        body: JSON.stringify({ title: trimmed, collectionId })
      });
      navigate(`/stories/${story.id}/edit`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("stories:errors.create"));
      setSaving(false);
    }
  };

  return (
    <Modal
      variant="card"
      title={t("stories:collections.addStory")}
      icon={<Plus size={20} />}
      busy={saving}
      onClose={onClose}
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
    >
      {error && <MessageBox tone="error" title={t("stories:errors.createTitle")}>{error}</MessageBox>}
      <label className="field">
        <span>{t("stories:fields.title")}</span>
        <input
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t("stories:fields.titlePlaceholder")}
          maxLength={160}
        />
      </label>
      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={saving}>{t("common:common.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={saving || !title.trim()}>
          {saving ? t("stories:actions.creating") : t("stories:actions.create")}
        </Button>
      </div>
    </Modal>
  );
}

interface AccessPayload {
  members: { subjectType: "user" | "group"; subjectId: string; role: string; name: string | null; email: string | null }[];
  everyoneRole: string | null;
  candidates: { users: { id: string; name: string }[]; groups: { id: string; name: string }[] };
}

const GRANT_ROLES = ["viewer", "contributor", "manager", "deny"] as const;

// Who may see this shelf (and therefore its stories), who may add to it, who
// runs it. The Everyone row is the baseline: viewer = open to the household,
// none = only the people listed here.
function CollectionAccessModal({
  collectionId,
  title,
  onClose
}: {
  collectionId: string;
  title: string;
  onClose: () => void;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const [access, setAccess] = useState<AccessPayload | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [subject, setSubject] = useState("");
  const [newRole, setNewRole] = useState<(typeof GRANT_ROLES)[number]>("viewer");

  const load = () => {
    api<AccessPayload>(`/api/stories/collections/${collectionId}/access`)
      .then(setAccess)
      .catch((err) => setError(err instanceof Error ? err.message : t("stories:errors.load")));
  };
  useEffect(load, [collectionId]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("stories:errors.save"));
    } finally {
      setBusy(false);
    }
  };

  const grant = (subjectType: string, subjectId: string, role: string) =>
    run(() => api(`/api/stories/collections/${collectionId}/access`, {
      method: "POST",
      body: JSON.stringify({ subjectType, subjectId, role })
    }));

  const revoke = (subjectType: string, subjectId: string) =>
    run(() => api(`/api/stories/collections/${collectionId}/access/${subjectType}/${subjectId}`, { method: "DELETE" }));

  const setEveryone = (role: string) =>
    run(() => api(`/api/stories/collections/${collectionId}/access/everyone`, {
      method: "PUT",
      body: JSON.stringify({ role: role === "none" ? null : role })
    }));

  const add = () => {
    const [subjectType, subjectId] = subject.split(":");
    if (!subjectType || !subjectId) return;
    setSubject("");
    void grant(subjectType, subjectId, newRole);
  };

  const roleLabel = (role: string) => t(`stories:collections.roles.${role as "viewer"}`);
  const granted = new Set(access?.members.map((member) => `${member.subjectType}:${member.subjectId}`));

  return (
    <Modal
      variant="panel"
      title={t("stories:collections.accessTitle", { name: title })}
      icon={<ShieldCheck size={20} />}
      busy={busy}
      onClose={onClose}
    >
      <div className="modal-tab-content story-access">
        {error && <MessageBox tone="error" title={t("stories:errors.saveTitle")}>{error}</MessageBox>}
        <p className="muted">{t("stories:collections.accessIntro")}</p>

        {!access && !error && <p className="management-empty">{t("stories:common.loading")}</p>}

        {access && (
          <>
            {/* The household baseline. "None" is what restricts the shelf. */}
            <div className="story-access-row">
              <span className="story-access-icon" aria-hidden="true"><Globe2 size={16} /></span>
              <span className="story-access-who">
                <strong>{t("stories:collections.everyone")}</strong>
                <small className="muted">{t("stories:collections.everyoneHint")}</small>
              </span>
              <select
                value={access.everyoneRole ?? "none"}
                onChange={(event) => void setEveryone(event.target.value)}
                disabled={busy}
                aria-label={t("stories:collections.everyone")}
              >
                <option value="none">{t("stories:collections.roles.none")}</option>
                <option value="viewer">{t("stories:collections.roles.viewer")}</option>
                <option value="contributor">{t("stories:collections.roles.contributor")}</option>
              </select>
            </div>

            {access.members.map((member) => (
              <div className="story-access-row" key={`${member.subjectType}:${member.subjectId}`}>
                <span className="story-access-icon" aria-hidden="true">
                  {member.subjectType === "group" ? <UsersRound size={16} /> : <UserRound size={16} />}
                </span>
                <span className="story-access-who">
                  <strong>{member.name ?? member.subjectId}</strong>
                  {member.email && <small className="muted">{member.email}</small>}
                </span>
                <select
                  value={member.role}
                  onChange={(event) => void grant(member.subjectType, member.subjectId, event.target.value)}
                  disabled={busy}
                  aria-label={t("stories:collections.roleFor", { name: member.name ?? member.subjectId })}
                >
                  {GRANT_ROLES.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}
                </select>
                <Button
                  variant="icon"
                  danger
                  onClick={() => void revoke(member.subjectType, member.subjectId)}
                  disabled={busy}
                  aria-label={t("stories:collections.removeGrant", { name: member.name ?? member.subjectId })}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            ))}

            <div className="story-access-add">
              <select value={subject} onChange={(event) => setSubject(event.target.value)} disabled={busy}>
                <option value="">{t("stories:collections.pickSubject")}</option>
                <optgroup label={t("stories:collections.usersGroup")}>
                  {access.candidates.users
                    .filter((candidate) => !granted.has(`user:${candidate.id}`))
                    .map((candidate) => <option key={candidate.id} value={`user:${candidate.id}`}>{candidate.name}</option>)}
                </optgroup>
                <optgroup label={t("stories:collections.groupsGroup")}>
                  {access.candidates.groups
                    .filter((candidate) => !granted.has(`group:${candidate.id}`))
                    .map((candidate) => <option key={candidate.id} value={`group:${candidate.id}`}>{candidate.name}</option>)}
                </optgroup>
              </select>
              <select
                value={newRole}
                onChange={(event) => setNewRole(event.target.value as (typeof GRANT_ROLES)[number])}
                disabled={busy}
                aria-label={t("stories:collections.roleField")}
              >
                {GRANT_ROLES.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}
              </select>
              <Button variant="secondary" compact onClick={add} disabled={busy || !subject}>
                {t("stories:collections.grant")}
              </Button>
            </div>
          </>
        )}

        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose}>{t("common:common.close")}</Button>
        </div>
      </div>
    </Modal>
  );
}
