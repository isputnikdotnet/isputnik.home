import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft, Baby, Heart, ImagePlus, Link2, Network, Pencil, Play, Trash2, Upload, X
} from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { followRoute, getReferrer, navigate } from "../../router";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MessageBox } from "../../shared/MessageBox";
import { AddChildModal } from "./AddChildModal";
import { AddUnionModal } from "./AddUnionModal";
import { FamilyPhotoPicker } from "./FamilyPhotoPicker";
import { GalleryPersonLinkModal } from "./GalleryPersonLinkModal";
import { PersonAvatar } from "./PersonAvatar";
import { PersonEditModal } from "./PersonEditModal";
import { lifeYears, UNION_STATUS_OPTIONS, type FamilyPersonProfile, type FamilyPhoto } from "./types";

const PHOTO_PAGE = 40;

function PersonChip({ person, relation }: { person: { id: string; name: string; portraitUrl: string | null }; relation?: string }) {
  return (
    <a
      className="ft-chip"
      href={`/family/people/${person.id}`}
      onClick={(event) => followRoute(event, `/family/people/${person.id}`)}
    >
      <PersonAvatar person={person} size={28} />
      <span>{person.name}</span>
      {relation && relation !== "biological" && <small className="ft-chip-relation">{relation}</small>}
    </a>
  );
}

// One family member: profile fields, relationships, and the merged photo wall
// (curated attachments + linked face-cluster photos). Admins edit everything
// here; everyone else gets a read-only view of the same layout.
export function FamilyPersonPage({ id, user, logout }: { id: string; user: PublicUser; logout: () => Promise<void> }) {
  const isAdmin = user.role === "admin";
  const [profile, setProfile] = useState<FamilyPersonProfile | null>(null);
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
  const [photoPicker, setPhotoPicker] = useState(false);
  const [portraitPicker, setPortraitPicker] = useState(false);
  const [linkModal, setLinkModal] = useState(false);
  const [removeUnionId, setRemoveUnionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
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
    void loadProfile();
    loadPhotos(0).catch(() => {});
  }, [loadProfile, loadPhotos]);

  const refresh = () => {
    void loadProfile();
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
      <section className="audiobook-main-page ft-profile-page">
        {error && <MessageBox tone="error" title="Unable to load">{error}</MessageBox>}
        {actionError && <MessageBox tone="error" title="Action failed">{actionError}</MessageBox>}

        {profile && (
          <>
            <div className="ft-profile-top">
              <a className="text-button ft-back-link" href={back} onClick={(event) => followRoute(event, back)}>
                <ArrowLeft size={16} aria-hidden="true" />
                Back
              </a>
              <a
                className="secondary-button compact-button"
                href={`/family/tree/${profile.id}`}
                onClick={(event) => followRoute(event, `/family/tree/${profile.id}`)}
              >
                <Network size={16} aria-hidden="true" />
                Show in tree
              </a>
            </div>

            <header className="ft-profile-header">
              <PersonAvatar person={profile} size={112} />
              <div className="ft-profile-headline">
                <h1>{profile.name}</h1>
                <p className="ft-profile-sub">
                  {[
                    profile.maidenName ? `née ${profile.maidenName}` : "",
                    lifeYears(profile),
                    profile.birthplace ? `born in ${profile.birthplace}` : ""
                  ].filter(Boolean).join(" · ")}
                </p>
                {isAdmin && (
                  <div className="ft-profile-actions">
                    <Button variant="secondary" compact onClick={() => setEditOpen(true)}>
                      <Pencil size={15} aria-hidden="true" />
                      Edit
                    </Button>
                    <Button variant="secondary" compact onClick={() => portraitFileRef.current?.click()}>
                      <Upload size={15} aria-hidden="true" />
                      Upload portrait
                    </Button>
                    <Button variant="secondary" compact onClick={() => setPortraitPicker(true)}>
                      <ImagePlus size={15} aria-hidden="true" />
                      Portrait from gallery
                    </Button>
                    {(profile.portraitUrl || profile.portraitItemId) && (
                      <Button variant="text" compact danger onClick={() => void removePortrait()}>
                        Remove portrait
                      </Button>
                    )}
                    <Button variant="secondary" compact danger onClick={() => setDeleteOpen(true)}>
                      <Trash2 size={15} aria-hidden="true" />
                      Delete
                    </Button>
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
                )}
              </div>
            </header>

            {profile.bio && <p className="ft-profile-bio">{profile.bio}</p>}

            <section className="ft-section">
              <div className="ft-section-head">
                <h2>Family</h2>
                {isAdmin && (
                  <div className="row-actions">
                    <Button variant="secondary" compact onClick={() => setUnionModal(true)}>
                      <Heart size={15} aria-hidden="true" />
                      Add partner
                    </Button>
                    <Button variant="secondary" compact onClick={() => setChildModal(true)}>
                      <Baby size={15} aria-hidden="true" />
                      Add child
                    </Button>
                  </div>
                )}
              </div>

              {profile.parents.length > 0 && (
                <div className="ft-relation-row">
                  <span className="ft-relation-label">Parents</span>
                  <div className="ft-chip-row">
                    {profile.parents.map((parent) => (
                      <PersonChip key={parent.id} person={parent} relation={profile.parentRelation ?? undefined} />
                    ))}
                  </div>
                </div>
              )}

              {profile.unions.map((union) => (
                <div key={union.id} className="ft-union-block">
                  <div className="ft-relation-row">
                    <span className="ft-relation-label">
                      {union.partner ? statusLabel(union.status) : "Single parent"}
                      {union.marriedDate ? ` ${union.marriedDate.slice(0, 4)}` : ""}
                    </span>
                    <div className="ft-chip-row">
                      {union.partner && <PersonChip person={union.partner} />}
                      {isAdmin && (
                        <button
                          type="button"
                          className="ft-chip-remove"
                          title="Remove this union"
                          aria-label="Remove this union"
                          onClick={() => setRemoveUnionId(union.id)}
                        >
                          <X size={14} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </div>
                  {union.children.length > 0 && (
                    <div className="ft-relation-row ft-children-row">
                      <span className="ft-relation-label">Children</span>
                      <div className="ft-chip-row">
                        {union.children.map((child) => (
                          <span key={child.id} className="ft-chip-wrap">
                            <PersonChip person={child} relation={child.relation} />
                            {isAdmin && (
                              <button
                                type="button"
                                className="ft-chip-remove"
                                title={`Remove ${child.name} from this family`}
                                aria-label={`Remove ${child.name} from this family`}
                                onClick={() => void removeChildLink(union.id, child.id)}
                              >
                                <X size={14} aria-hidden="true" />
                              </button>
                            )}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {profile.parents.length === 0 && profile.unions.length === 0 && (
                <p className="management-empty">No relationships recorded yet.</p>
              )}
            </section>

            <section className="ft-section">
              <div className="ft-section-head">
                <h2>Photos{photoTotal > 0 ? ` (${photoTotal})` : ""}</h2>
                {isAdmin && (
                  <div className="row-actions">
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
              </div>

              {photos.length === 0 ? (
                <p className="management-empty">
                  {isAdmin
                    ? "No photos yet. Attach some from the gallery, or link a gallery person to surface their photos automatically."
                    : "No photos yet."}
                </p>
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
                        <button
                          type="button"
                          className="ft-photo-remove"
                          title="Remove from this person"
                          aria-label="Remove from this person"
                          onClick={() => void detachPhoto(photo.id)}
                        >
                          <X size={14} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  ))}
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
          </>
        )}
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
      {portraitPicker && profile && (
        <FamilyPhotoPicker
          title={`Choose a portrait for ${profile.name}`}
          single
          onPickSingle={(asset) => {
            setPortraitPicker(false);
            api(`/api/family-tree/persons/${profile.id}`, {
              method: "PATCH",
              body: JSON.stringify({ portraitItemId: asset.id })
            })
              .then(() => refresh())
              .catch((err) => setActionError(err instanceof Error ? err.message : "Unable to set the portrait"));
          }}
          onClose={() => setPortraitPicker(false)}
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
