// The Photo Inbox review page — docs/photo-inbox-proposal.md.
//
// An Inbox is a gallery library flagged as a holding place: re-scanned prints, a
// relative's phone dump. Nothing in it appears anywhere else until someone keeps
// it, and this page is how it is emptied: every photo ends as Keep (moved into a
// real library) or Discard (to the Recycle Bin). The grid, the tiles and the
// lightbox are the gallery's own; only the two verbs are new. Deliveries — the
// top-level folder a batch arrived in — are the page's one grouping, so Grandma's
// box and this morning's scanner run can be reviewed one at a time.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Album, CalendarDays, CheckCheck, Film, FolderInput, FolderOpen, Inbox, LibraryBig, Link2, ListChecks,
  ScanSearch, SquareCheck, Trash2, UploadCloud, Users, X
} from "lucide-react";
import { DropLinksModal } from "./DropLinksModal";
import { api } from "../../api";
import { PartialBulkError, sendInBatches } from "../../shared/bulk";
import { DashboardShell } from "../../app/DashboardShell";
import { controlHref, followRoute, galleryHref, galleryInboxHref, galleryReviewHref, navigate } from "../../router";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MessageBox } from "../../shared/MessageBox";
import { LibraryPageHeader } from "../../shared/LibraryPageHeader";
import { LibraryPageToolbar } from "../../shared/LibraryPageToolbar";
import { SectionNav, type SectionNavItem } from "../../shared/SectionNav";
import { SelectField } from "../../shared/SelectField";
import { useIsMobile } from "../../shared/useIsMobile";
import { AssetTile } from "./AssetTile";
import { GalleryLightbox, type GalleryAssetChange } from "./GalleryLightbox";
import { GalleryUploadModal } from "./GalleryUploadModal";
import { GalleryKeepModal, type KeepDestination } from "./GalleryKeepModal";
import { galleryGridClass, readGalleryView } from "./gallery-view";
import type { GalleryAsset, GalleryLibrary } from "./types";
import { useSession } from "../../app/SessionContext";

export interface PhotoInboxDelivery {
  folder: string;
  count: number;
  /** Gone through in Review mode (docs/photo-review-plan.md). */
  reviewed: number;
  newestAt: string;
  /** Some of it came in through a drop link. */
  viaLink: boolean;
}

export interface PhotoInboxSummary {
  id: string;
  name: string;
  count: number;
  reviewed: number;
  /** May Keep or Discard (delete on the Inbox). */
  canReview: boolean;
  /** May write on the photos (edit on the Inbox) — Review mode's right. */
  canEdit: boolean;
  deliveries: PhotoInboxDelivery[];
}

interface ReviewCounts extends Record<string, number> {
  done: number;
  forbidden: number;
  missing: number;
  locked: number;
  failed: number;
}

/** What the server says about this Inbox's duplicate check — the cleanup job
 *  that compares the Inbox with the rest of the collection (phase 2). */
interface InboxCheckView {
  jobId: string;
  status: "draft" | "scanning" | "review" | "processing" | "paused" | "completed" | "failed" | "cancelled";
  scanProgress: number;
  statusDetail: string | null;
  results: number;
  remaining: number;
  isOwner: boolean;
}

interface InboxCheckState {
  check: InboxCheckView | null;
  blockedBy: "other_job" | null;
}

const PAGE_SIZE = 80;
const CHECK_POLL_MS = 2000;

export function PhotoInboxPage({
  libraryId
}: {
  /** /gallery/inbox/<id> names one Inbox; the bare address opens the first. */
  libraryId: string | null;
}) {
  const { user } = useSession();
  const { t } = useTranslation(["common", "gallery"]);
  const isMobile = useIsMobile();
  const isAdmin = user.role === "admin";

  const [inboxes, setInboxes] = useState<PhotoInboxSummary[] | null>(null);
  const [libraries, setLibraries] = useState<GalleryLibrary[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [folder, setFolder] = useState<string | null>(null);
  const [assets, setAssets] = useState<GalleryAsset[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const [keepOpen, setKeepOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [dropLinksOpen, setDropLinksOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  const inbox = useMemo(() => {
    if (!inboxes) return null;
    return (libraryId ? inboxes.find((candidate) => candidate.id === libraryId) : inboxes[0]) ?? null;
  }, [inboxes, libraryId]);
  const inboxLibrary = useMemo(() => libraries.find((library) => library.id === inbox?.id) ?? null, [libraries, inbox]);
  // Where a kept photo may go: libraries this user can add to, never another Inbox.
  const destinations = useMemo(() => libraries.filter((library) => library.canUpload && !library.inbox), [libraries]);
  const gridClass = galleryGridClass(readGalleryView().tileSize);

  const loadInboxes = useCallback(async () => {
    try {
      const [inboxPayload, libraryPayload] = await Promise.all([
        api<{ inboxes: PhotoInboxSummary[] }>("/api/library/gallery/inbox"),
        api<{ libraries: GalleryLibrary[] }>("/api/library/gallery-libraries")
      ]);
      setInboxes(inboxPayload.inboxes);
      setLibraries(libraryPayload.libraries);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:inbox.errors.load"));
      setInboxes((current) => current ?? []);
    }
  }, [t]);

  const loadAssets = useCallback(async (inboxId: string, delivery: string | null, offset: number) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (delivery != null) params.set("folder", delivery);
      const payload = await api<{ items: GalleryAsset[]; total: number }>(`/api/library/gallery/inbox/${inboxId}/items?${params}`);
      setAssets((current) => (offset === 0 ? payload.items : [...current, ...payload.items]));
      setTotal(payload.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:inbox.errors.load"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void loadInboxes(); }, [loadInboxes]);

  // A different Inbox, or a delivery that no longer exists, starts the grid over.
  useEffect(() => {
    setFolder(null);
    setSelectedIds(new Set());
    setSelectionMode(false);
    setLightboxIndex(null);
  }, [inbox?.id]);

  useEffect(() => {
    if (!inbox) { setAssets([]); setTotal(0); return; }
    void loadAssets(inbox.id, folder, 0);
  }, [inbox?.id, folder, loadAssets]); // eslint-disable-line react-hooks/exhaustive-deps

  // The Inbox's duplicate check. Read with the Inbox, polled while it scans, and
  // re-read after every Keep or Discard — a resolved set is a set fewer to show.
  const [check, setCheck] = useState<InboxCheckState | null>(null);
  const loadCheck = useCallback(async (inboxId: string) => {
    try {
      setCheck(await api<InboxCheckState>(`/api/library/gallery/inbox/${inboxId}/check`));
    } catch {
      setCheck(null);
    }
  }, []);
  useEffect(() => {
    if (!inbox) { setCheck(null); return; }
    void loadCheck(inbox.id);
  }, [inbox?.id, loadCheck]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const status = check?.check?.status;
    if (!inbox || (status !== "scanning" && status !== "processing")) return;
    const handle = window.setInterval(() => { void loadCheck(inbox.id); }, CHECK_POLL_MS);
    return () => window.clearInterval(handle);
  }, [inbox?.id, check?.check?.status, loadCheck]); // eslint-disable-line react-hooks/exhaustive-deps

  const startCheck = async () => {
    if (!inbox) return;
    setBusy(true);
    setActionError("");
    try {
      const started = await api<InboxCheckState & { start: { queued: boolean; reason?: string } }>(
        `/api/library/gallery/inbox/${inbox.id}/check`,
        { method: "POST", body: "{}" }
      );
      setCheck({ check: started.check, blockedBy: started.blockedBy });
      if (!started.start.queued && started.start.reason === "busy") setNotice(t("gallery:inbox.check.blockedBody"));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("gallery:inbox.check.startFailed"));
    } finally {
      setBusy(false);
    }
  };

  const refresh = useCallback(async () => {
    await loadInboxes();
    if (inbox) {
      await loadAssets(inbox.id, folder, 0);
      await loadCheck(inbox.id);
    }
  }, [loadInboxes, loadAssets, loadCheck, inbox, folder]);

  const exitSelection = () => { setSelectionMode(false); setSelectedIds(new Set()); };
  const toggleSelect = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const removeAssets = (ids: Set<string>) => {
    setAssets((current) => current.filter((asset) => !ids.has(asset.id)));
    setTotal((current) => Math.max(0, current - ids.size));
  };

  const summarise = (counts: ReviewCounts, doneKey: "gallery:inbox.keptNotice" | "gallery:inbox.discardedNotice") => {
    const parts: string[] = [t(doneKey, { count: counts.done })];
    if (counts.forbidden > 0) parts.push(t("gallery:bulk.skippedPermissionNotice", { count: counts.forbidden }));
    if (counts.locked > 0) parts.push(t("gallery:bulk.lockedFoldersNotice", { count: counts.locked }));
    if (counts.failed > 0) parts.push(t("gallery:bulk.failedNotice", { count: counts.failed }));
    return `${parts.join(" · ")}.`;
  };

  const keep = async (dest: KeepDestination) => {
    setBusy(true);
    setActionError("");
    const ids = [...selectedIds];
    try {
      const counts = await sendInBatches<ReviewCounts>(ids, (itemIds) => api("/api/library/gallery/inbox/keep", {
        method: "POST",
        body: JSON.stringify({ itemIds, libraryId: dest.libraryId, folder: dest.folder, dated: dest.dated })
      }));
      setKeepOpen(false);
      exitSelection();
      setNotice(summarise(counts, "gallery:inbox.keptNotice"));
      await refresh();
    } catch (err) {
      setActionError(err instanceof PartialBulkError || err instanceof Error ? err.message : t("gallery:inbox.errors.keep"));
      if (err instanceof PartialBulkError) await refresh();
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    setBusy(true);
    setActionError("");
    const ids = [...selectedIds];
    try {
      const counts = await sendInBatches<ReviewCounts>(ids, (itemIds) => api("/api/library/gallery/inbox/discard", {
        method: "POST",
        body: JSON.stringify({ itemIds })
      }));
      setDiscardOpen(false);
      exitSelection();
      setNotice(summarise(counts, "gallery:inbox.discardedNotice"));
      await refresh();
    } catch (err) {
      setActionError(err instanceof PartialBulkError || err instanceof Error ? err.message : t("gallery:inbox.errors.discard"));
      if (err instanceof PartialBulkError) await refresh();
    } finally {
      setBusy(false);
    }
  };

  const handleAssetChange = useCallback((change: GalleryAssetChange) => {
    if (change.kind === "deleted") { removeAssets(new Set([change.id])); void loadInboxes(); return; }
    if (change.kind === "like") {
      setAssets((current) => current.map((asset) => (asset.id === change.id ? { ...asset, saved: change.saved } : asset)));
      return;
    }
    void refresh();
  }, [loadInboxes, refresh]);

  const navItems: SectionNavItem[] = [
    { key: "timeline", label: t("gallery:page.views.timeline"), href: galleryHref("timeline"), icon: CalendarDays },
    { key: "albums", label: t("gallery:page.views.albums"), href: galleryHref("albums"), icon: Album },
    { key: "slideshows", label: t("gallery:page.views.slideshows"), href: galleryHref("slideshows"), icon: Film },
    { key: "folder", label: t("gallery:page.views.folder"), href: galleryHref("folder"), icon: FolderOpen },
    { key: "people", label: t("gallery:page.views.people"), href: galleryHref("people"), icon: Users },
    { key: "inbox", label: t("gallery:inbox.title"), href: galleryInboxHref(null), icon: Inbox, count: inbox?.count }
  ];

  const canReview = inbox?.canReview === true;
  const deliveryLabel = (delivery: PhotoInboxDelivery) => delivery.folder || t("gallery:inbox.rootDelivery");
  const subtitle = inbox
    ? t("gallery:inbox.subtitle", { count: inbox.count, name: inbox.name })
    : undefined;

  return (
    <DashboardShell
      active="gallery"
      sideNav={<SectionNav ariaLabel={t("common:nav.gallery")} groupLabel={t("common:nav.gallery")} items={navItems} activeKey="inbox" />}
    >
      <section className={`audiobook-main-page gallery-page gallery-inbox-page${selectionMode ? " is-selecting" : ""}`}>
        <LibraryPageHeader title={t("gallery:inbox.title")} subtitle={subtitle} />

        {error && <MessageBox tone="error" title={t("gallery:inbox.errors.title")}>{error}</MessageBox>}
        {notice && <MessageBox tone="success" title={t("gallery:page.notices.galleryUpdatedTitle")}>{notice}</MessageBox>}
        {actionError && !keepOpen && !discardOpen && (
          <MessageBox tone="error" title={t("gallery:page.errors.unableToUpdateTitle")}>{actionError}</MessageBox>
        )}

        {inboxes && !inbox ? (
          <div className="empty-state library-empty">
            <Inbox size={58} aria-hidden="true" />
            <h2>{t("gallery:inbox.empty.noInboxTitle")}</h2>
            {isAdmin ? (
              <>
                <p className="muted">{t("gallery:inbox.empty.noInboxBodyAdmin")}</p>
                <a className="primary-button" href="/control/libraries" onClick={(event) => followRoute(event, "/control/libraries")}>
                  <LibraryBig size={16} aria-hidden="true" />
                  {t("gallery:page.empty.createLibraryButton")}
                </a>
              </>
            ) : (
              <p className="muted">{t("gallery:inbox.empty.noInboxBodyUser")}</p>
            )}
          </div>
        ) : inbox ? (
          <>
            <LibraryPageToolbar
              scope={inboxes && inboxes.length > 1 ? (
                <SelectField
                  compact
                  hideLabel
                  className="gallery-inbox-picker"
                  icon={<Inbox size={16} />}
                  label={t("gallery:inbox.pickerLabel")}
                  value={inbox.id}
                  onChange={(value: string) => navigate(galleryInboxHref(value))}
                  options={inboxes.map((candidate) => ({
                    value: candidate.id, label: `${candidate.name} (${candidate.count})`
                  }))}
                />
              ) : undefined}
              tools={
                <>
                  {inbox.canEdit && assets.length > 0 && (
                    <Button
                      variant="toolbar"
                      onClick={() => navigate(galleryReviewHref(inbox.id, folder))}
                      title={t("gallery:inbox.goThroughTitle")}
                    >
                      <ListChecks size={18} aria-hidden="true" />
                      <span className="toolbar-label">{t("gallery:inbox.goThrough")}</span>
                    </Button>
                  )}
                  {!isMobile && canReview && assets.length > 0 && (
                    <Button
                      variant="toolbar"
                      onClick={() => { setNotice(""); setActionError(""); setSelectionMode(true); }}
                    >
                      <SquareCheck size={18} aria-hidden="true" />
                      <span className="toolbar-label">{t("gallery:common.select")}</span>
                    </Button>
                  )}
                  {canReview && (
                    <Button
                      variant="toolbar"
                      onClick={() => { setNotice(""); setDropLinksOpen(true); }}
                      title={t("gallery:inbox.dropLinks.buttonTitle")}
                    >
                      <Link2 size={18} aria-hidden="true" />
                      <span className="toolbar-label">{t("gallery:inbox.dropLinks.button")}</span>
                    </Button>
                  )}
                  {inboxLibrary?.canUpload && (
                    <Button
                      variant="toolbar"
                      className="primary"
                      onClick={() => { setNotice(""); setUploadOpen(true); }}
                      title={t("gallery:inbox.uploadTitle")}
                    >
                      <UploadCloud size={18} aria-hidden="true" />
                      <span className="toolbar-label">{t("gallery:inbox.upload")}</span>
                    </Button>
                  )}
                </>
              }
              selection={selectionMode ? {
                count: selectedIds.size,
                actions: (
                  <>
                    <Button
                      variant="toolbar"
                      onClick={() => setSelectedIds(new Set(assets.map((asset) => asset.id)))}
                      disabled={assets.length === 0}
                      title={t("gallery:bulk.selectAllTitle")}
                    >
                      <CheckCheck size={18} aria-hidden="true" />
                      <span className="toolbar-label">{t("gallery:bulk.all")}</span>
                    </Button>
                    <Button
                      variant="toolbar"
                      className="primary"
                      onClick={() => { setActionError(""); setKeepOpen(true); }}
                      disabled={selectedIds.size === 0 || busy}
                      title={t("gallery:inbox.keepTitle")}
                    >
                      <FolderInput size={18} aria-hidden="true" />
                      <span className="toolbar-label">{t("gallery:inbox.keep")}</span>
                    </Button>
                    <Button
                      variant="toolbar" danger
                      onClick={() => { setActionError(""); setDiscardOpen(true); }}
                      disabled={selectedIds.size === 0 || busy}
                      title={t("gallery:inbox.discardTitle")}
                    >
                      <Trash2 size={18} aria-hidden="true" />
                      <span className="toolbar-label">{t("gallery:inbox.discard")}</span>
                    </Button>
                    <Button
                      variant="toolbar"
                      onClick={exitSelection}
                      title={t("gallery:bulk.leaveSelectionTitle")}
                    >
                      <X size={18} aria-hidden="true" />
                    </Button>
                  </>
                )
              } : null}
              strip={inbox.deliveries.length > 1 ? (
                <div className="gallery-inbox-deliveries" role="group" aria-label={t("gallery:inbox.deliveriesLabel")}>
                  <Button
                    variant="bare"
                    className={`gallery-inbox-delivery${folder === null ? " is-active" : ""}`}
                    onClick={() => setFolder(null)}
                  >
                    {t("gallery:inbox.allDeliveries")} <span className="count-badge">{inbox.count}</span>
                  </Button>
                  {inbox.deliveries.map((delivery) => (
                    <Button
                      variant="bare"
                      key={delivery.folder || "\u0000root"}
                      className={`gallery-inbox-delivery${folder === delivery.folder ? " is-active" : ""}`}
                      onClick={() => setFolder(delivery.folder)}
                      title={delivery.folder || t("gallery:inbox.rootDeliveryTitle")}
                    >
                      {delivery.viaLink && <Link2 size={12} aria-hidden="true" />}
                      {deliveryLabel(delivery)}{" "}
                      <span
                        className="count-badge"
                        title={delivery.reviewed > 0 ? t("gallery:inbox.notedOf", { reviewed: delivery.reviewed, count: delivery.count }) : undefined}
                      >
                        {delivery.reviewed > 0 ? `${delivery.reviewed}/${delivery.count}` : delivery.count}
                      </span>
                    </Button>
                  ))}
                </div>
              ) : undefined}
            />

            {!canReview && inbox.count > 0 && (
              inbox.canEdit ? (
                <MessageBox tone="info" title={t("gallery:inbox.helperTitle")}>{t("gallery:inbox.helperBody")}</MessageBox>
              ) : (
                <MessageBox tone="info" title={t("gallery:inbox.readOnlyTitle")}>{t("gallery:inbox.readOnlyBody")}</MessageBox>
              )
            )}

            {/* The duplicate check — "12 new, 3 look like copies". Its sets are worked
                through on the cleanup page, which is the admin's; here the Inbox says
                what the check found and where to go. */}
            {check?.blockedBy === "other_job" && isAdmin && inbox.count > 0 && (
              <MessageBox tone="info" title={t("gallery:inbox.check.blockedTitle")}>
                {t("gallery:inbox.check.blockedBody")}
              </MessageBox>
            )}
            {check?.check && (check.check.status === "scanning" || check.check.status === "processing" || check.check.status === "draft") && (
              <MessageBox tone="info" title={t("gallery:inbox.check.runningTitle")}>
                {t("gallery:inbox.check.runningBody", { percent: check.check.scanProgress })}
              </MessageBox>
            )}
            {check?.check && check.check.status === "failed" && (
              <MessageBox tone="error" title={t("gallery:inbox.check.failedTitle")}>
                {check.check.statusDetail ?? t("gallery:inbox.check.failedBody")}
              </MessageBox>
            )}
            {check?.check && (check.check.status === "review" || check.check.status === "paused") && (
              check.check.remaining > 0 ? (
                <MessageBox
                  tone="warning"
                  title={t("gallery:inbox.check.foundTitle", { count: check.check.remaining })}
                  action={isAdmin ? (
                    <a
                      className="secondary-button compact-button"
                      href={controlHref("duplicateCleanup")}
                      onClick={(event) => followRoute(event, controlHref("duplicateCleanup"))}
                    >
                      {t("gallery:inbox.check.review")}
                    </a>
                  ) : undefined}
                >
                  {t("gallery:inbox.check.foundBody")}
                </MessageBox>
              ) : (
                <MessageBox tone="success" title={t("gallery:inbox.check.noneTitle")}>
                  {t("gallery:inbox.check.noneBody", { count: check.check.results })}
                </MessageBox>
              )
            )}
            {check && !check.check && !check.blockedBy && isAdmin && inbox.count > 0 && (
              <div className="gallery-inbox-check-offer">
                <Button variant="secondary" onClick={() => void startCheck()} disabled={busy}>
                  <ScanSearch size={16} aria-hidden="true" />
                  {t("gallery:inbox.check.start")}
                </Button>
                <span className="muted">{t("gallery:inbox.check.startHint")}</span>
              </div>
            )}

            {!loading && assets.length === 0 ? (
              <div className="empty-state library-empty gallery-inbox-done">
                <CheckCheck size={58} aria-hidden="true" />
                <h2>{folder === null ? t("gallery:inbox.empty.allReviewedTitle") : t("gallery:inbox.empty.deliveryReviewedTitle")}</h2>
                <p className="muted">
                  {folder === null ? t("gallery:inbox.empty.allReviewedBody", { name: inbox.name }) : t("gallery:inbox.empty.deliveryReviewedBody")}
                </p>
              </div>
            ) : (
              <>
                <div className={gridClass}>
                  {assets.map((asset, index) => (
                    <AssetTile
                      key={asset.id}
                      asset={asset}
                      onOpen={() => setLightboxIndex(index)}
                      selectionMode={selectionMode}
                      selected={selectedIds.has(asset.id)}
                      onToggleSelect={() => toggleSelect(asset.id)}
                    />
                  ))}
                </div>
                {assets.length < total && (
                  <div className="gallery-load-more">
                    <Button variant="secondary" disabled={loading} onClick={() => void loadAssets(inbox.id, folder, assets.length)}>
                      {loading ? t("gallery:common.loading") : t("gallery:common.loadMoreCount", { count: total - assets.length })}
                    </Button>
                  </div>
                )}
              </>
            )}
          </>
        ) : (
          <p className="muted">{t("gallery:common.loading")}</p>
        )}
      </section>

      {lightboxIndex != null && assets[lightboxIndex] && (
        <GalleryLightbox
          assets={assets}
          index={lightboxIndex}
          canDelete={false}
          canEdit={inbox?.canEdit === true}
          onClose={() => setLightboxIndex(null)}
          onIndexChange={setLightboxIndex}
          onChanged={handleAssetChange}
        />
      )}

      {keepOpen && (
        <GalleryKeepModal
          count={selectedIds.size}
          libraries={destinations}
          busy={busy}
          error={actionError}
          onClose={() => { if (!busy) setKeepOpen(false); }}
          onKeep={(dest) => void keep(dest)}
        />
      )}

      {discardOpen && (
        <ConfirmDialog
          title={t("gallery:inbox.discardConfirmTitle", { count: selectedIds.size })}
          confirmLabel={t("gallery:inbox.discardConfirmLabel", { count: selectedIds.size })}
          busyLabel={t("gallery:inbox.discarding")}
          busy={busy}
          error={actionError}
          danger
          onConfirm={() => void discard()}
          onCancel={() => { if (!busy) setDiscardOpen(false); }}
        >
          {t("gallery:inbox.discardConfirmBody")}
        </ConfirmDialog>
      )}

      {dropLinksOpen && inbox && (
        <DropLinksModal
          inbox={{ id: inbox.id, name: inbox.name }}
          onClose={() => { setDropLinksOpen(false); void refresh(); }}
        />
      )}

      {uploadOpen && inboxLibrary && (
        <GalleryUploadModal
          libraries={[inboxLibrary]}
          onClose={() => setUploadOpen(false)}
          onUploaded={(count, libraryName) => {
            setUploadOpen(false);
            setNotice(t("gallery:inbox.uploadedNotice", { count, name: libraryName }));
            void refresh();
          }}
        />
      )}

    </DashboardShell>
  );
}
