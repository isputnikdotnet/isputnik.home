import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft, Baby, BookMarked, CalendarPlus, ExternalLink, Heart, ImagePlus, Link2, Network, Pencil, Play, Trash2, Upload, X
} from "lucide-react";
import { api, type PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { followRoute, getReferrer, navigate } from "../../router";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MessageBox } from "../../shared/MessageBox";
import { AddChildModal } from "./AddChildModal";
import { AddUnionModal } from "./AddUnionModal";
import { CitationEditModal } from "./CitationEditModal";
import { EventEditModal } from "./EventEditModal";
import { FamilyPhotoPicker } from "./FamilyPhotoPicker";
import { GalleryPersonLinkModal } from "./GalleryPersonLinkModal";
import { PersonAvatar } from "./PersonAvatar";
import { PersonEditModal } from "./PersonEditModal";
import {
  lifeYears, EVENT_TYPE_OPTIONS, UNION_STATUS_OPTIONS,
  type FamilyCitation, type FamilyEvent, type FamilyPersonProfile, type FamilyPhoto
} from "./types";

const PHOTO_PAGE = 40;

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
  event: FamilyEvent | null;
}

function timelineEntries(profile: FamilyPersonProfile): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  if (profile.birthDate || profile.birthplace) {
    entries.push({
      key: "birth",
      sortKey: "0000",
      dateText: profile.birthDate ?? "",
      title: "Born",
      meta: profile.birthplace ? [profile.birthplace] : [],
      note: null,
      event: null
    });
  }
  for (const union of profile.unions) {
    if (union.partner && (union.marriedDate || union.marriedPlace)) {
      entries.push({
        key: `marr-${union.id}`,
        sortKey: union.marriedDate ?? "9998",
        dateText: union.marriedDate ?? "",
        title: `Married ${union.partner.name}`,
        meta: union.marriedPlace ? [union.marriedPlace] : [],
        note: null,
        event: null
      });
    }
    if (union.partner && union.divorcedDate) {
      entries.push({
        key: `div-${union.id}`,
        sortKey: union.divorcedDate,
        dateText: union.divorcedDate,
        title: `Divorced ${union.partner.name}`,
        meta: [],
        note: null,
        event: null
      });
    }
  }
  for (const event of profile.events) {
    entries.push({
      key: event.id,
      sortKey: event.date ?? "9998",
      dateText: [event.date, event.endDate].filter(Boolean).join("–"),
      title: event.label || eventTypeLabel(event.type),
      meta: [event.label ? eventTypeLabel(event.type) : "", event.place ?? ""].filter(Boolean),
      note: event.note,
      event
    });
  }
  if (profile.deathDate || profile.deathPlace) {
    entries.push({
      key: "death",
      sortKey: profile.deathDate ?? "9999",
      dateText: profile.deathDate ?? "",
      title: "Died",
      meta: profile.deathPlace ? [profile.deathPlace] : [],
      note: null,
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
  // false = closed, null = adding, FamilyEvent = editing.
  const [eventModal, setEventModal] = useState<FamilyEvent | null | false>(false);
  const [removeEvent, setRemoveEvent] = useState<FamilyEvent | null>(null);
  const [citationModal, setCitationModal] = useState<FamilyCitation | null | false>(false);
  const [removeCitation, setRemoveCitation] = useState<FamilyCitation | null>(null);
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
                <h2>Life events</h2>
                {isAdmin && (
                  <div className="row-actions">
                    <Button variant="secondary" compact onClick={() => setEventModal(null)}>
                      <CalendarPlus size={15} aria-hidden="true" />
                      Add event
                    </Button>
                  </div>
                )}
              </div>

              {(() => {
                const entries = timelineEntries(profile);
                if (entries.length === 0) {
                  return (
                    <p className="management-empty">
                      {isAdmin
                        ? "No events yet. Add school, work, moves, or anything else that tells this person's story."
                        : "No events recorded yet."}
                    </p>
                  );
                }
                return (
                  <ol className="ft-timeline">
                    {entries.map((entry) => (
                      <li key={entry.key} className="ft-timeline-row">
                        <span className="ft-timeline-date">{entry.dateText || "—"}</span>
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
                );
              })()}
            </section>

            <section className="ft-section">
              <div className="ft-section-head">
                <h2>Sources{profile.citations.length > 0 ? ` (${profile.citations.length})` : ""}</h2>
                {isAdmin && (
                  <div className="row-actions">
                    <Button variant="secondary" compact onClick={() => setCitationModal(null)}>
                      <BookMarked size={15} aria-hidden="true" />
                      Add source
                    </Button>
                  </div>
                )}
              </div>

              {profile.citations.length === 0 ? (
                <p className="management-empty">
                  {isAdmin
                    ? "No sources yet. Cite the records, sites, or documents that back this person's facts."
                    : "No sources recorded yet."}
                </p>
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
