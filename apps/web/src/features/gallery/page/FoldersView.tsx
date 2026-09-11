import { useTranslation } from "react-i18next";
import { ChevronRight, Folder, FolderOutput, Lock, LockOpen, MessageSquareText, RefreshCw } from "lucide-react";
import { Button } from "../../../shared/Button";
import type { AskSomeoneSource } from "../AskSomeoneModal";
import { AssetTile, type LightboxSource } from "../AssetTile";
import type { GalleryAsset } from "../types";
import { MoveFolderModal } from "./MoveFolderModal";
import type { useFolderAdmin } from "./useFolderAdmin";
import type { useFolderBrowse } from "./useFolderBrowse";

// Folders: the library's own folder tree — breadcrumb, subfolders, the photos
// directly inside — or, while the header's box has a term, the folders whose
// NAME matches it. Admins get rescan / lock / move on the open folder.
export function FoldersView({
  browse,
  admin,
  folderQuery,
  setSearchText,
  soleLibraryId,
  isAdmin,
  setAskSomeone,
  gridClass,
  loading,
  selectionMode,
  selectedIds,
  toggleSelect,
  toggleAssetLike,
  openLightbox
}: {
  browse: ReturnType<typeof useFolderBrowse>;
  admin: ReturnType<typeof useFolderAdmin>;
  folderQuery: string;
  setSearchText: (text: string) => void;
  soleLibraryId: string | null;
  isAdmin: boolean;
  setAskSomeone: (source: AskSomeoneSource) => void;
  gridClass: string;
  loading: boolean;
  selectionMode: boolean;
  selectedIds: Set<string>;
  toggleSelect: (id: string) => void;
  toggleAssetLike: (asset: GalleryAsset, next: boolean) => Promise<void>;
  openLightbox: (source: LightboxSource, index: number) => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  const { parent, parentLocked, folders, folderAssets, folderTotal, folderSubtreeTotal, folderMatches, loadFolder } = browse;
  const {
    folderRescanBusy, rescanFolder, folderLockBusy, toggleFolderLock,
    moveFolderOpen, setMoveFolderOpen, moveTarget, movePlan, moveBusy, moveError, moveTargets,
    openMoveFolder, planMoveFolder, confirmMoveFolder
  } = admin;
  const breadcrumbParts = parent ? parent.split("/") : [];

  if (folderMatches) {
    /* Folder-NAME search, everywhere in scope. Clicking a result opens the
       folder and clears the box — the term found its answer. The browse
       state underneath is untouched, so clearing by hand lands back where
       you were. */
    return (
      <>
        <p className="gallery-section-label">
          {folderMatches.total === 0
            ? t("gallery:folders.noMatchTitle")
            : folderMatches.total > folderMatches.folders.length
              ? t("gallery:folders.matchingHeadingLimited", { query: folderQuery, total: folderMatches.total, shown: folderMatches.folders.length })
              : t("gallery:folders.matchingHeading", { query: folderQuery, total: folderMatches.total })}
        </p>
        {folderMatches.folders.length > 0 ? (
          <div className="gallery-folder-grid">
            {folderMatches.folders.map((folder) => (
              <button
                key={folder.path}
                type="button"
                className="gallery-folder-tile"
                title={folder.path}
                onClick={() => { setSearchText(""); void loadFolder(folder.path); }}
              >
                <span className="gallery-folder-thumb">
                  {folder.coverUrl ? <img src={folder.coverUrl} alt="" loading="lazy" /> : <Folder size={28} aria-hidden="true" />}
                </span>
                <strong>{folder.name}</strong>
                {/* Where it sits — the name alone can't tell 2004's "wedding"
                    from 2019's. Top-level folders have nowhere to say. */}
                {folder.path.includes("/") && (
                  <small className="gallery-folder-where">{folder.path.slice(0, folder.path.lastIndexOf("/"))}</small>
                )}
                <small>
                  {folder.locked && <Lock size={12} className="gallery-folder-lock" aria-label={t("gallery:folders.lockedAria")} />}
                  {t("gallery:common.counts.item", { count: folder.assetCount })}
                </small>
              </button>
            ))}
          </div>
        ) : (
          <p className="management-empty">{t("gallery:folders.noNameContains", { query: folderQuery })}</p>
        )}
      </>
    );
  }

  return (
    <>
      <div className="gallery-folder-bar">
        <div className="gallery-breadcrumb">
          <button type="button" onClick={() => void loadFolder("")}>{t("gallery:folders.allFolders")}</button>
          {breadcrumbParts.map((part, i) => {
            const target = breadcrumbParts.slice(0, i + 1).join("/");
            return (
              <span key={target} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <ChevronRight size={14} aria-hidden="true" />
                <button type="button" onClick={() => void loadFolder(target)}>{part}</button>
              </span>
            );
          })}
        </div>
        {/* "Ask someone" over a whole folder: the folder's photos become an
            album sent with the question (docs/for-you-plan.md). Needs one
            library in scope, since a folder path is only unique within it. */}
        {soleLibraryId && parent !== "" && folderSubtreeTotal > 0 && (
          <Button
            variant="secondary"
            compact
            title={t("gallery:folders.askSomeoneTitle")}
            onClick={() => setAskSomeone({ kind: "folder", libraryId: soleLibraryId, path: parent })}
          >
            <MessageSquareText size={14} aria-hidden="true" />
            {" "}
            {t("gallery:folders.askSomeone")}
          </Button>
        )}
        {isAdmin && soleLibraryId && parent !== "" && (
          <>
            <Button
              variant="secondary"
              compact
              disabled={folderLockBusy}
              title={parentLocked
                ? t("gallery:folders.unlockTitle")
                : t("gallery:folders.lockTitle")}
              onClick={() => void toggleFolderLock()}
            >
              {parentLocked ? <LockOpen size={14} aria-hidden="true" /> : <Lock size={14} aria-hidden="true" />}
              {" "}
              {folderLockBusy
                ? (parentLocked ? t("gallery:folders.unlocking") : t("gallery:folders.locking"))
                : (parentLocked ? t("gallery:folders.unlockFolder") : t("gallery:folders.lockFolder"))}
            </Button>
            <Button
              variant="secondary"
              compact
              disabled={folderRescanBusy}
              title={t("gallery:folders.rescanTitle")}
              onClick={() => void rescanFolder()}
            >
              <RefreshCw size={14} aria-hidden="true" /> {folderRescanBusy ? t("gallery:folders.rescanStarting") : t("gallery:folders.rescanButton")}
            </Button>
            <Button
              variant="secondary"
              compact
              disabled={moveTargets.length === 0}
              title={moveTargets.length === 0 ? t("gallery:folders.moveNoTargets") : t("gallery:folders.moveTitle")}
              onClick={openMoveFolder}
            >
              <FolderOutput size={14} aria-hidden="true" /> {t("gallery:folders.moveFolder")}
            </Button>
          </>
        )}
      </div>

      {moveFolderOpen && soleLibraryId && (
        <MoveFolderModal
          folder={parent}
          targets={moveTargets}
          target={moveTarget}
          plan={movePlan}
          busy={moveBusy}
          error={moveError}
          onPlan={(value) => void planMoveFolder(value)}
          onConfirm={() => void confirmMoveFolder()}
          onClose={() => setMoveFolderOpen(false)}
        />
      )}

      {folders.length > 0 && (
        <>
          <p className="gallery-section-label">{t("gallery:folders.foldersHeading", { count: folders.length })}</p>
          <div className="gallery-folder-grid">
            {folders.map((folder) => (
              <button key={folder.path} type="button" className="gallery-folder-tile" onClick={() => void loadFolder(folder.path)}>
                <span className="gallery-folder-thumb">
                  {folder.coverUrl ? <img src={folder.coverUrl} alt="" loading="lazy" /> : <Folder size={28} aria-hidden="true" />}
                </span>
                <strong>{folder.name}</strong>
                <small>
                  {folder.locked && <Lock size={12} className="gallery-folder-lock" aria-label={t("gallery:folders.lockedAria")} />}
                  {t("gallery:common.counts.item", { count: folder.assetCount })}
                </small>
              </button>
            ))}
          </div>
        </>
      )}

      {folderAssets.length > 0 && (
        <>
          <p className="gallery-section-label">{t("gallery:folders.photosVideosHeading", { count: folderTotal })}</p>
          <div className={gridClass}>
            {folderAssets.map((asset, index) => (
              <AssetTile
                key={asset.id}
                asset={asset}
                onOpen={() => openLightbox("folder", index)}
                selectionMode={selectionMode}
                selected={selectedIds.has(asset.id)}
                onToggleSelect={() => toggleSelect(asset.id)}
                onToggleLike={(next) => void toggleAssetLike(asset, next)}
              />
            ))}
          </div>
          {folderAssets.length < folderTotal && (
            <div style={{ display: "flex", justifyContent: "center", padding: "16px 0" }}>
              <button type="button" className="secondary-button" onClick={() => void loadFolder(parent, folderAssets.length)} disabled={loading}>
                {loading ? t("gallery:common.loading") : t("gallery:common.loadMore")}
              </button>
            </div>
          )}
        </>
      )}

      {!loading && folders.length === 0 && folderAssets.length === 0 && (
        <p className="management-empty">{t("gallery:folders.emptyFolder")}</p>
      )}
    </>
  );
}
