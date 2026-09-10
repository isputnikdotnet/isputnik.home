import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Boxes } from "lucide-react";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { MessageBox } from "../../../shared/MessageBox";
import { RefreshButton } from "../../../shared/RefreshButton";
import { formatBytes, formatManagedDate } from "../../../shared/utils";
import { controlHref } from "../../../router";
import { ControlSectionHead } from "../ControlSectionHead";

// The Contents page beside Storage (server: modules/library/app-storage-contents.ts).
//
// Storage says where each room is; this says what is in it. Every room gets a
// count and a size. The App files library is listed folder by folder, file by
// file, each with the thing that owns it — the story, the photo, the track, the
// slideshow, the person — so an admin can see what is taking the space and
// why. A file nothing owns any more is an orphan, and the one thing this page
// deletes. Files the app's folders do not account for are "other", with the
// way out: move their folder to another library, from the gallery.

type AppRoom = "trash" | "inbox" | "house" | "thumbnails" | "renders" | "backups";

interface RoomContents {
  room: AppRoom;
  mode: "app" | "own" | "off";
  path: string | null;
  files: number;
  bytes: number;
  complete: boolean;
  library: { id: string; name: string } | null;
}

interface AppFileOwner {
  type: "story" | "photo" | "track" | "slideshow" | "person";
  id: string;
  title: string;
  folder?: string;
  libraryId?: string;
}

interface AppFileEntry {
  itemId: string;
  relativePath: string;
  kind: string;
  size: number;
  addedAt: string;
  owner: AppFileOwner | null;
  orphan: boolean;
}

type FolderKey = "recordings" | "voiceNotes" | "music" | "movies" | "familyTree" | "other";

interface AppFileFolder {
  key: FolderKey;
  folder: string;
  files: number;
  bytes: number;
  orphans: number;
  entries: AppFileEntry[];
}

interface Contents {
  path: string | null;
  rooms: RoomContents[];
  staging: { files: number; bytes: number; complete: boolean; path: string | null };
  appFiles: { library: { id: string; name: string; path: string } | null; folders: AppFileFolder[] };
}

const folderHref = (libraryId: string, folder: string): string =>
  `/gallery/folders/${folder.split("/").map(encodeURIComponent).join("/")}?library=${encodeURIComponent(libraryId)}`;

function ownerHref(owner: AppFileOwner): string | null {
  switch (owner.type) {
    case "story": return `/stories/${owner.id}`;
    case "slideshow": return `/gallery/slideshows/${owner.id}`;
    case "person": return `/family/people/${owner.id}`;
    case "photo": return owner.libraryId != null && owner.folder != null && owner.folder !== "" ? folderHref(owner.libraryId, owner.folder) : null;
    case "track": return null;
  }
}

export function StorageContentsSection() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [contents, setContents] = useState<Contents | null>(null);
  const [error, setError] = useState("");
  const [target, setTarget] = useState<AppFileEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const roomName: Record<AppRoom, string> = {
    trash: t("controlAdmin:storage.roomTrash"),
    inbox: t("controlAdmin:storage.roomInbox"),
    house: t("controlAdmin:storage.roomHouse"),
    thumbnails: t("controlAdmin:storage.roomThumbnails"),
    renders: t("controlAdmin:storage.roomRenders"),
    backups: t("controlAdmin:storage.roomBackups")
  };
  const folderName: Record<FolderKey, string> = {
    recordings: t("controlAdmin:storageContents.folderRecordings"),
    voiceNotes: t("controlAdmin:storageContents.folderVoiceNotes"),
    music: t("controlAdmin:storageContents.folderMusic"),
    movies: t("controlAdmin:storageContents.folderMovies"),
    familyTree: t("controlAdmin:storageContents.folderFamilyTree"),
    other: t("controlAdmin:storageContents.folderOther")
  };
  const ownerLabel: Record<AppFileOwner["type"], string> = {
    story: t("controlAdmin:storageContents.ownerStory"),
    photo: t("controlAdmin:storageContents.ownerPhoto"),
    track: t("controlAdmin:storageContents.ownerTrack"),
    slideshow: t("controlAdmin:storageContents.ownerSlideshow"),
    person: t("controlAdmin:storageContents.ownerPerson")
  };

  const load = async () => {
    setError("");
    try {
      setContents(await api<Contents>("/api/storage/app-storage/contents"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:storageContents.loadFailed"));
      throw err;
    }
  };

  useEffect(() => {
    load().catch(() => { /* shown in the box */ });
  }, []);

  const deleteOrphan = async () => {
    if (!target) return;
    setDeleting(true);
    setDeleteError("");
    try {
      const payload = await api<{ contents: Contents }>("/api/storage/app-storage/contents/delete", {
        method: "POST",
        body: JSON.stringify({ itemId: target.itemId })
      });
      setContents(payload.contents);
      setTarget(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t("controlAdmin:storageContents.deleteFailed"));
    } finally {
      setDeleting(false);
    }
  };

  const whereText = (room: RoomContents): string => {
    if (room.mode === "off") return t("controlAdmin:storageContents.roomOff");
    return room.mode === "app" ? t("controlAdmin:storageContents.roomApp") : t("controlAdmin:storageContents.roomOwn");
  };
  const countText = (files: number, complete: boolean): string =>
    complete ? files.toLocaleString() : t("controlAdmin:storageContents.atLeast", { count: files });

  const totalBytes = contents ? contents.rooms.reduce((sum, room) => sum + room.bytes, 0) + contents.staging.bytes : 0;

  return (
    <>
      <ControlSectionHead
        section="storageContents"
        icon={<Boxes size={30} />}
        iconClassName="storage"
        description={t("controlAdmin:storageContents.description")}
      >
        <RefreshButton onRefresh={load} />
      </ControlSectionHead>

      {error && <MessageBox tone="error" title={t("controlAdmin:storageContents.loadFailed")}>{error}</MessageBox>}

      {contents && !contents.path && (
        <MessageBox tone="info" title={t("controlAdmin:storageContents.notSetTitle")}>
          {t("controlAdmin:storageContents.notSetBody")}{" "}
          <a href={controlHref("storage")}>{t("controlAdmin:storageContents.openStorage")}</a>
        </MessageBox>
      )}

      {contents && (
        <section className="storage-section">
          <div className="storage-section-head">
            <div>
              <h2>{t("controlAdmin:storageContents.roomsTitle")}</h2>
              <p>{t("controlAdmin:storageContents.roomsIntro", { size: formatBytes(totalBytes) })}</p>
            </div>
          </div>
          <div className="datagrid-wrap">
            <table className="datagrid">
              <thead>
                <tr>
                  <th>{t("controlAdmin:storage.thRoom")}</th>
                  <th>{t("controlAdmin:storage.thWhere")}</th>
                  <th className="col-num">{t("controlAdmin:storageContents.thFiles")}</th>
                  <th className="col-num">{t("controlAdmin:storageContents.thSize")}</th>
                </tr>
              </thead>
              <tbody>
                {contents.rooms.map((room) => (
                  <tr key={room.room}>
                    <td><strong>{roomName[room.room]}</strong></td>
                    <td className="storage-path-cell">
                      {room.path ? <code className="app-storage-path">{room.path}</code> : <span className="datagrid-muted">—</span>}
                      <div className="datagrid-muted app-storage-from">
                        {[whereText(room), room.library?.name].filter(Boolean).join(" · ")}
                      </div>
                    </td>
                    <td className="col-num">{room.mode === "off" ? "—" : countText(room.files, room.complete)}</td>
                    <td className="col-num">{room.mode === "off" ? "—" : formatBytes(room.bytes)}</td>
                  </tr>
                ))}
                {contents.staging.path && (
                  <tr>
                    <td><strong>{t("controlAdmin:storageContents.staging")}</strong></td>
                    <td className="storage-path-cell">
                      <code className="app-storage-path">{contents.staging.path}</code>
                      <div className="datagrid-muted app-storage-from">{t("controlAdmin:storageContents.stagingHint")}</div>
                    </td>
                    <td className="col-num">{countText(contents.staging.files, contents.staging.complete)}</td>
                    <td className="col-num">{formatBytes(contents.staging.bytes)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {contents && (
        <section className="library-settings-panel storage-settings-panel app-storage-panel">
          <div>
            <h2>{t("controlAdmin:storageContents.appFilesTitle")}</h2>
            <p>{t("controlAdmin:storageContents.appFilesIntro")}</p>
          </div>
          {!contents.appFiles.library ? (
            <p className="datagrid-muted app-storage-locked">{t("controlAdmin:storageContents.appFilesNone")}</p>
          ) : (
            <>
              <div className="storage-path-summary">
                <strong>{contents.appFiles.library.name}</strong>
                <span className="datagrid-muted"> · </span>
                <code className="app-storage-path">{contents.appFiles.library.path}</code>
              </div>
              {contents.appFiles.folders.length === 0 && (
                <p className="datagrid-muted">{t("controlAdmin:storageContents.appFilesEmpty")}</p>
              )}
              {contents.appFiles.folders.map((folder) => (
                <div key={folder.key} className="storage-contents-folder">
                  <div className="storage-section-head">
                    <div>
                      <h3>{folderName[folder.key]}</h3>
                      <p className="datagrid-muted">
                        {t("controlAdmin:storageContents.folderSummary", { count: folder.files, size: formatBytes(folder.bytes) })}
                        {folder.orphans > 0 && <> · <span className="needs-attention">{t("controlAdmin:storageContents.orphansCount", { count: folder.orphans })}</span></>}
                      </p>
                      {folder.key === "other" && (
                        <p className="datagrid-muted">
                          {t("controlAdmin:storageContents.folderOtherHint")}{" "}
                          <a href={`/gallery/folders?library=${encodeURIComponent(contents.appFiles.library!.id)}`}>{t("controlAdmin:storageContents.openInGallery")}</a>
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="datagrid-wrap">
                    <table className="datagrid">
                      <thead>
                        <tr>
                          <th>{t("controlAdmin:storageContents.thFile")}</th>
                          <th>{t("controlAdmin:storageContents.thOwner")}</th>
                          <th>{t("controlAdmin:storageContents.thAdded")}</th>
                          <th className="col-num">{t("controlAdmin:storageContents.thSize")}</th>
                          <th className="col-actions"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {folder.entries.map((entry) => {
                          const href = entry.owner ? ownerHref(entry.owner) : null;
                          return (
                            <tr key={entry.itemId}>
                              <td className="storage-path-cell">
                                <code className="app-storage-path">{entry.relativePath}</code>
                              </td>
                              <td>
                                {entry.owner ? (
                                  <>
                                    <span className="datagrid-muted">{ownerLabel[entry.owner.type]}: </span>
                                    {href ? <a href={href}>{entry.owner.title}</a> : entry.owner.title}
                                  </>
                                ) : entry.orphan ? (
                                  <span className="needs-attention">{t("controlAdmin:storageContents.orphan")}</span>
                                ) : (
                                  <span className="datagrid-muted">{t("controlAdmin:storageContents.notAppMade")}</span>
                                )}
                              </td>
                              <td>{formatManagedDate(entry.addedAt)}</td>
                              <td className="col-num">{formatBytes(entry.size)}</td>
                              <td className="col-actions">
                                {entry.orphan && (
                                  <Button variant="text" danger compact disabled={deleting} onClick={() => { setDeleteError(""); setTarget(entry); }}>
                                    {t("controlAdmin:storageContents.deleteOrphan")}
                                  </Button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {folder.files > folder.entries.length && (
                    <p className="datagrid-muted">{t("controlAdmin:storageContents.moreEntries", { shown: folder.entries.length, count: folder.files })}</p>
                  )}
                </div>
              ))}
            </>
          )}
        </section>
      )}

      {target && (
        <ConfirmDialog
          title={t("controlAdmin:storageContents.confirmDeleteTitle", { name: target.relativePath.split("/").pop() ?? target.relativePath })}
          confirmLabel={t("controlAdmin:storageContents.deleteOrphan")}
          busyLabel={t("controlAdmin:storageContents.deleting")}
          danger
          busy={deleting}
          error={deleteError || undefined}
          onConfirm={() => void deleteOrphan()}
          onCancel={() => { setTarget(null); setDeleteError(""); }}
        >
          {t("controlAdmin:storageContents.confirmDeleteBody")}
        </ConfirmDialog>
      )}
    </>
  );
}
