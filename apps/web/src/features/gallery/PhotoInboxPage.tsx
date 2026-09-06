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
  Album, CalendarDays, CheckCheck, Film, FolderInput, FolderOpen, Inbox, LibraryBig,
  SquareCheck, Trash2, UploadCloud, Users, X
} from "lucide-react";
import { api, type PublicUser } from "../../api";
import { PartialBulkError, sendInBatches } from "../../shared/bulk";
import { DashboardShell } from "../../app/DashboardShell";
import { followRoute, galleryHref, galleryInboxHref, navigate } from "../../router";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MessageBox } from "../../shared/MessageBox";
import { LibraryPageHeader } from "../../shared/LibraryPageHeader";
import { LibraryPageToolbar } from "../../shared/LibraryPageToolbar";
import { SectionNav, type SectionNavItem } from "../../shared/SectionNav";
import { useIsMobile } from "../../shared/useIsMobile";
import { AssetTile } from "./AssetTile";
import { GalleryLightbox, type GalleryAssetChange } from "./GalleryLightbox";
import { GalleryUploadModal } from "./GalleryUploadModal";
import { GalleryKeepModal, type KeepDestination } from "./GalleryKeepModal";
import { galleryGridClass, readGalleryView } from "./gallery-view";
import type { GalleryAsset, GalleryLibrary } from "./types";

export interface PhotoInboxDelivery {
  folder: string;
  count: number;
  newestAt: string;
}

export interface PhotoInboxSummary {
  id: string;
  name: string;
  count: number;
  canReview: boolean;
  deliveries: PhotoInboxDelivery[];
}

interface ReviewCounts extends Record<string, number> {
  done: number;
  forbidden: number;
  missing: number;
  locked: number;
  failed: number;
}

const PAGE_SIZE = 80;

export function PhotoInboxPage({
  user,
  logout,
  libraryId
}: {
  user: PublicUser;
  logout: () => Promise<void>;
  /** /gallery/inbox/<id> names one Inbox; the bare address opens the first. */
  libraryId: string | null;
}) {
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

  const refresh = useCallback(async () => {
    await loadInboxes();
    if (inbox) await loadAssets(inbox.id, folder, 0);
  }, [loadInboxes, loadAssets, inbox, folder]);

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
      user={user}
      logout={logout}
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
                <label className="gallery-inbox-picker">
                  <span className="sr-only">{t("gallery:inbox.pickerLabel")}</span>
                  <select value={inbox.id} onChange={(event) => navigate(galleryInboxHref(event.target.value))}>
                    {inboxes.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.name} ({candidate.count})
                      </option>
                    ))}
                  </select>
                </label>
              ) : undefined}
              tools={
                <>
                  {!isMobile && canReview && assets.length > 0 && (
                    <button
                      type="button"
                      className="library-toolbar-button"
                      onClick={() => { setNotice(""); setActionError(""); setSelectionMode(true); }}
                    >
                      <SquareCheck size={18} aria-hidden="true" />
                      <span className="toolbar-label">{t("gallery:common.select")}</span>
                    </button>
                  )}
                  {inboxLibrary?.canUpload && (
                    <button
                      type="button"
                      className="library-toolbar-button primary"
                      onClick={() => { setNotice(""); setUploadOpen(true); }}
                      title={t("gallery:inbox.uploadTitle")}
                    >
                      <UploadCloud size={18} aria-hidden="true" />
                      <span className="toolbar-label">{t("gallery:inbox.upload")}</span>
                    </button>
                  )}
                </>
              }
              selection={selectionMode ? {
                count: selectedIds.size,
                actions: (
                  <>
                    <button
                      type="button"
                      className="library-toolbar-button"
                      onClick={() => setSelectedIds(new Set(assets.map((asset) => asset.id)))}
                      disabled={assets.length === 0}
                      title={t("gallery:bulk.selectAllTitle")}
                    >
                      <CheckCheck size={18} aria-hidden="true" />
                      <span className="toolbar-label">{t("gallery:bulk.all")}</span>
                    </button>
                    <button
                      type="button"
                      className="library-toolbar-button primary"
                      onClick={() => { setActionError(""); setKeepOpen(true); }}
                      disabled={selectedIds.size === 0 || busy}
                      title={t("gallery:inbox.keepTitle")}
                    >
                      <FolderInput size={18} aria-hidden="true" />
                      <span className="toolbar-label">{t("gallery:inbox.keep")}</span>
                    </button>
                    <button
                      type="button"
                      className="library-toolbar-button danger"
                      onClick={() => { setActionError(""); setDiscardOpen(true); }}
                      disabled={selectedIds.size === 0 || busy}
                      title={t("gallery:inbox.discardTitle")}
                    >
                      <Trash2 size={18} aria-hidden="true" />
                      <span className="toolbar-label">{t("gallery:inbox.discard")}</span>
                    </button>
                    <button
                      type="button"
                      className="library-toolbar-button"
                      onClick={exitSelection}
                      title={t("gallery:bulk.leaveSelectionTitle")}
                    >
                      <X size={18} aria-hidden="true" />
                    </button>
                  </>
                )
              } : null}
              strip={inbox.deliveries.length > 1 ? (
                <div className="gallery-inbox-deliveries" role="group" aria-label={t("gallery:inbox.deliveriesLabel")}>
                  <button
                    type="button"
                    className={`gallery-inbox-delivery${folder === null ? " is-active" : ""}`}
                    onClick={() => setFolder(null)}
                  >
                    {t("gallery:inbox.allDeliveries")} <span className="count-badge">{inbox.count}</span>
                  </button>
                  {inbox.deliveries.map((delivery) => (
                    <button
                      key={delivery.folder || " root"}
                      type="button"
                      className={`gallery-inbox-delivery${folder === delivery.folder ? " is-active" : ""}`}
                      onClick={() => setFolder(delivery.folder)}
                      title={delivery.folder || t("gallery:inbox.rootDeliveryTitle")}
                    >
                      {deliveryLabel(delivery)} <span className="count-badge">{delivery.count}</span>
                    </button>
                  ))}
                </div>
              ) : undefined}
            />

            {!canReview && inbox.count > 0 && (
              <MessageBox tone="info" title={t("gallery:inbox.readOnlyTitle")}>{t("gallery:inbox.readOnlyBody")}</MessageBox>
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
          canEdit={canReview}
          canShare={false}
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
