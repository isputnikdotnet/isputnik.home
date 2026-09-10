import { useState, useEffect, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { HardDrive, Plus } from "lucide-react";
import { api } from "../../../api";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { RefreshButton } from "../../../shared/RefreshButton";
import { SelectField } from "../../../shared/SelectField";
import type { StorageRoot } from "../types";
import { ControlSectionHead } from "../ControlSectionHead";
import { FolderPickerModal } from "../libraries/FolderPickerModal";

// The Storage page — docs/app-storage-plan.md, phase 1.
//
// App storage first: one folder the app may keep its own things in, and one row
// per "room" saying where that room is right now and offering to change it. The
// thumbnail folder and the Recycle Bin location, which used to be two blocks of
// their own, are rows here. Every change goes chooser → confirmation → save, and
// the confirmation names the exact folder and says what moves.

type AppRoom = "trash" | "inbox" | "house" | "thumbnails" | "renders" | "backups";
type RoomMode = "app" | "own" | "off";

/** A room's storage move task: running, or what the last one could not carry. */
interface StorageMove {
  running: boolean;
  jobId: string | null;
  label: string | null;
  from: string | null;
  to: string | null;
  done: number;
  pending: number;
  failed: { name: string; title?: string; error: string }[];
}

interface RoomView {
  room: AppRoom;
  mode: RoomMode;
  resolvedPath: string | null;
  appPath: string | null;
  holdsFiles: boolean;
  library: { id: string; name: string } | null;
  counts: { itemsInBin?: number; tracks?: number; clips?: number; waiting?: number; backups?: number };
  move: StorageMove;
}

interface AppStorageView {
  path: string | null;
  ready: boolean;
  error: string;
  lockedBy: AppRoom[];
  rooms: RoomView[];
  /** The gallery libraries the library rooms' own option can pick from. */
  libraries: { id: string; name: string; inbox: boolean }[];
}

/** What the admin picked in a room's chooser, before it is confirmed. `path` is
 *  the folder for "own" on the rooms that take one. */
interface PendingSwitch {
  room: AppRoom;
  mode: RoomMode;
  path: string | null;
  /** The gallery library for "own" on the Inbox and App files rooms. */
  libraryId: string | null;
}

const ROOM_ORDER: AppRoom[] = ["trash", "inbox", "house", "thumbnails", "renders", "backups"];

export function StorageSection() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [storage, setStorage] = useState<AppStorageView | null>(null);
  const [storageRoots, setStorageRoots] = useState<StorageRoot[]>([]);
  const [rootNameInput, setRootNameInput] = useState("");
  const [rootPathInput, setRootPathInput] = useState("");
  const [createStorageRootOpen, setCreateStorageRootOpen] = useState(false);
  const [savingStorageRoot, setSavingStorageRoot] = useState(false);
  const [deletingRootId, setDeletingRootId] = useState("");
  const [error, setError] = useState("");

  // The App storage folder: pick → confirm → save; or clear → confirm → save.
  const [appPickerOpen, setAppPickerOpen] = useState(false);
  const [appPathPending, setAppPathPending] = useState<string | null | undefined>(undefined);
  /** For each room that uses the folder now: carry it to the new folder (the
   *  default, absent) or leave it where it is (false). */
  const [carry, setCarry] = useState<Partial<Record<AppRoom, boolean>>>({});
  const [savingApp, setSavingApp] = useState(false);
  const [appError, setAppError] = useState("");

  // A room: chooser → (folder) → confirm → save.
  const [chooserRoom, setChooserRoom] = useState<AppRoom | null>(null);
  const [chooserMode, setChooserMode] = useState<RoomMode>("app");
  const [chooserLibrary, setChooserLibrary] = useState("");
  const [ownPickerRoom, setOwnPickerRoom] = useState<AppRoom | null>(null);
  const [thumbsInput, setThumbsInput] = useState("");
  const [pending, setPending] = useState<PendingSwitch | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState("");
  const [moveBusy, setMoveBusy] = useState(false);

  const roomName: Record<AppRoom, string> = {
    trash: t("controlAdmin:storage.roomTrash"),
    inbox: t("controlAdmin:storage.roomInbox"),
    house: t("controlAdmin:storage.roomHouse"),
    thumbnails: t("controlAdmin:storage.roomThumbnails"),
    renders: t("controlAdmin:storage.roomRenders"),
    backups: t("controlAdmin:storage.roomBackups")
  };
  const roomHint: Record<AppRoom, string> = {
    trash: t("controlAdmin:storage.roomTrashHint"),
    inbox: t("controlAdmin:storage.roomInboxHint"),
    house: t("controlAdmin:storage.roomHouseHint"),
    thumbnails: t("controlAdmin:storage.roomThumbnailsHint"),
    renders: t("controlAdmin:storage.roomRendersHint"),
    backups: t("controlAdmin:storage.roomBackupsHint")
  };

  const loadStorage = async () => {
    const [storagePayload, rootsPayload] = await Promise.all([
      api<AppStorageView>("/api/storage/app-storage"),
      api<{ roots: StorageRoot[] }>("/api/storage/roots")
    ]);
    setStorage(storagePayload);
    setStorageRoots(rootsPayload.roots);
  };

  useEffect(() => {
    loadStorage().catch((err) => setError(err instanceof Error ? err.message : t("controlAdmin:storage.loadFailed")));
  }, []);

  // While any room is being moved, keep the rows' counts fresh.
  const anyMoving = Boolean(storage?.rooms.some((room) => room.move.running));
  useEffect(() => {
    if (!anyMoving) return;
    const timer = setInterval(() => { loadStorage().catch(() => { /* next tick */ }); }, 2000);
    return () => clearInterval(timer);
  }, [anyMoving]);

  const rooms = ROOM_ORDER.map((room) => storage?.rooms.find((view) => view.room === room)).filter((room): room is RoomView => Boolean(room));
  /** The rooms that use the App storage folder now — what a change of folder
   *  carries along, or leaves behind, room by room. */
  const roomsInUse = rooms.filter((room) => room.mode === "app");

  // ── The App storage folder ────────────────────────────────────────────────

  const saveAppPath = async () => {
    if (appPathPending === undefined) return;
    setSavingApp(true);
    setAppError("");
    try {
      const payload = await api<AppStorageView>("/api/storage/app-storage", {
        method: "PUT",
        body: JSON.stringify({ path: appPathPending, carry })
      });
      setStorage(payload);
      setAppPathPending(undefined);
    } catch (err) {
      setAppError(err instanceof Error ? err.message : t("controlAdmin:storage.appSaveFailedTitle"));
    } finally {
      setSavingApp(false);
    }
  };

  // ── A room ────────────────────────────────────────────────────────────────

  const openChooser = (room: RoomView) => {
    setSwitchError("");
    setChooserMode(room.mode);
    setChooserLibrary(room.mode === "own" ? room.library?.id ?? "" : "");
    setChooserRoom(room.room);
  };

  /** Continue from the chooser: some choices need a folder first, some go to
   *  another page, the rest go straight to the confirmation. */
  const continueFromChooser = () => {
    if (!chooserRoom) return;
    const room = chooserRoom;
    const mode = chooserMode;
    setChooserRoom(null);
    if (mode === "own" && (room === "inbox" || room === "house")) {
      if (!chooserLibrary) return;
      setPending({ room, mode, path: null, libraryId: chooserLibrary });
      return;
    }
    if (mode === "own" && room === "trash") {
      setOwnPickerRoom("trash");
      return;
    }
    if (mode === "own" && room === "thumbnails") {
      setThumbsInput(rooms.find((view) => view.room === "thumbnails")?.resolvedPath ?? "");
      setOwnPickerRoom("thumbnails");
      return;
    }
    setPending({ room, mode, path: null, libraryId: null });
  };

  const applySwitch = async () => {
    if (!pending) return;
    setSwitching(true);
    setSwitchError("");
    try {
      const payload = await api<{ storage: AppStorageView }>(`/api/storage/app-storage/rooms/${pending.room}`, {
        method: "PUT",
        body: JSON.stringify({ mode: pending.mode, path: pending.path, libraryId: pending.libraryId })
      });
      setStorage(payload.storage);
      setPending(null);
    } catch (err) {
      setSwitchError(err instanceof Error ? err.message : t("controlAdmin:storage.switchFailedTitle", { room: roomName[pending.room] }));
    } finally {
      setSwitching(false);
    }
  };

  /** Retry (POST) or stop (DELETE) a room's storage move. */
  const moveAction = async (method: "POST" | "DELETE", room: AppRoom) => {
    setMoveBusy(true);
    try {
      await api(`/api/storage/app-storage/rooms/${room}/move`, { method });
      await loadStorage();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:storage.loadFailed"));
    } finally {
      setMoveBusy(false);
    }
  };

  // ── Containers ────────────────────────────────────────────────────────────

  const createStorageRoot = async (event: FormEvent) => {
    event.preventDefault();
    setSavingStorageRoot(true);
    setError("");
    try {
      await api("/api/storage/roots", {
        method: "POST",
        body: JSON.stringify({ name: rootNameInput, path: rootPathInput })
      });
      setRootNameInput("");
      setRootPathInput("");
      setCreateStorageRootOpen(false);
      await loadStorage();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:storage.saveContainerFailed"));
    } finally {
      setSavingStorageRoot(false);
    }
  };

  const deleteStorageRoot = async (root: StorageRoot) => {
    setDeletingRootId(root.id);
    setError("");
    try {
      await api(`/api/storage/roots/${root.id}`, { method: "DELETE" });
      await loadStorage();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:storage.deleteContainerFailed"));
    } finally {
      setDeletingRootId("");
    }
  };

  // ── What a row says ───────────────────────────────────────────────────────

  const whereText = (room: RoomView): { path: string; from: string } => {
    const s = (key: "fromApp" | "fromOwn" | "fromOwnLibrary" | "fromAppLibrary" | "fromThumbs" | "fromBackupPath" | "fromDefaultTrash" | "roomOff" | "roomNotSet") =>
      t(`controlAdmin:storage.${key}`);
    switch (room.room) {
      case "trash":
        return room.mode === "off"
          ? { path: s("fromDefaultTrash"), from: "" }
          : { path: room.resolvedPath ?? "", from: room.mode === "app" ? s("fromApp") : s("fromOwn") };
      case "inbox":
      case "house":
        return room.mode === "off"
          ? { path: s("roomOff"), from: "" }
          : { path: room.resolvedPath ?? "", from: room.mode === "app" ? s("fromAppLibrary") : s("fromOwnLibrary") };
      case "thumbnails":
        return room.mode === "off"
          ? { path: s("roomNotSet"), from: "" }
          : { path: room.resolvedPath ?? "", from: room.mode === "app" ? s("fromApp") : s("fromOwn") };
      case "renders":
        return { path: room.resolvedPath ?? "", from: room.mode === "app" ? s("fromApp") : s("fromThumbs") };
      case "backups":
        return { path: room.resolvedPath ?? "", from: room.mode === "app" ? s("fromApp") : s("fromBackupPath") };
    }
  };

  const countText = (room: RoomView): string => {
    if (room.room === "trash" && room.counts.itemsInBin !== undefined && room.counts.itemsInBin > 0) {
      return t("controlAdmin:storage.itemsInBin", { count: room.counts.itemsInBin });
    }
    if (room.room === "inbox" && room.library && room.counts.waiting !== undefined) {
      return t("controlAdmin:storage.waiting", { count: room.counts.waiting });
    }
    if (room.room === "renders" && room.counts.tracks !== undefined && room.counts.tracks > 0) {
      return t("controlAdmin:storage.tracks", { count: room.counts.tracks });
    }
    if (room.room === "backups" && room.counts.backups !== undefined && room.counts.backups > 0) {
      return t("controlAdmin:storage.backupsCount", { count: room.counts.backups });
    }
    return "";
  };


  // ── What a room does when the folder changes ──────────────────────────────

  /** One line under a room in the folder-change confirmation: what carrying it
   *  along does, or what leaving it where it is means for that room. */
  const carryCopy = (room: RoomView, carried: boolean): string => {
    const here = room.resolvedPath ?? "";
    switch (room.room) {
      case "trash":
        return carried
          ? t("controlAdmin:storage.carryTrash", { count: room.counts.itemsInBin ?? 0 })
          : t("controlAdmin:storage.stayFolder", { path: here });
      case "inbox":
      case "house":
        return carried ? t("controlAdmin:storage.carryLibrary") : t("controlAdmin:storage.stayLibrary", { path: here });
      case "thumbnails":
        return carried ? t("controlAdmin:storage.carryThumbnails") : t("controlAdmin:storage.stayFolder", { path: here });
      case "renders":
        return carried ? t("controlAdmin:storage.carryNow") : t("controlAdmin:storage.stayRenders");
      case "backups":
        return carried ? t("controlAdmin:storage.carryNow") : t("controlAdmin:storage.stayBackups");
    }
  };

  // ── The confirmation for a pending switch ─────────────────────────────────

  const confirmCopy = (switchTo: PendingSwitch): { title: string; body: string; label: string } => {
    const view = rooms.find((room) => room.room === switchTo.room);
    const target = switchTo.mode === "app" ? view?.appPath ?? "" : switchTo.path ?? "";
    const name = view?.library?.name ?? "";
    const picked = storage?.libraries.find((library) => library.id === switchTo.libraryId)?.name ?? "";
    switch (switchTo.room) {
      case "trash": {
        const count = view?.counts.itemsInBin ?? 0;
        return {
          title: switchTo.mode === "off"
            ? t("controlAdmin:storage.confirmTrashOffTitle")
            : t(switchTo.mode === "app" ? "controlAdmin:storage.confirmTrashAppTitle" : "controlAdmin:storage.confirmTrashOwnTitle", { path: target }),
          body: t("controlAdmin:storage.confirmTrashBody", { count }),
          label: t("controlAdmin:storage.confirmTrashLabel")
        };
      }
      case "renders": {
        const count = (view?.counts.tracks ?? 0) + (view?.counts.clips ?? 0);
        return {
          title: switchTo.mode === "app"
            ? t("controlAdmin:storage.confirmRendersAppTitle", { path: target })
            : t("controlAdmin:storage.confirmRendersOwnTitle"),
          body: t("controlAdmin:storage.confirmRendersBody", { count }),
          label: t("controlAdmin:storage.confirmRendersLabel")
        };
      }
      case "thumbnails":
        return {
          title: t(switchTo.mode === "app" ? "controlAdmin:storage.confirmThumbsAppTitle" : "controlAdmin:storage.confirmThumbsOwnTitle", { path: target }),
          body: t("controlAdmin:storage.confirmThumbsBody"),
          label: t("controlAdmin:storage.confirmThumbsLabel")
        };
      case "inbox":
        if (switchTo.mode === "own") {
          return { title: t("controlAdmin:storage.confirmInboxOwnTitle", { name: picked }), body: t("controlAdmin:storage.confirmInboxOwnBody"), label: t("controlAdmin:storage.confirmInboxOwnLabel") };
        }
        // An Inbox of your own moves into App storage, photos and all; a new one
        // is made only when there is none.
        if (switchTo.mode === "app" && view?.mode === "own" && view.library) {
          return {
            title: t("controlAdmin:storage.confirmInboxMoveTitle", { path: target }),
            body: t("controlAdmin:storage.confirmInboxMoveBody", { name, count: view.counts.waiting ?? 0 }),
            label: t("controlAdmin:storage.confirmInboxMoveLabel")
          };
        }
        return switchTo.mode === "app"
          ? { title: t("controlAdmin:storage.confirmInboxAppTitle", { path: target }), body: t("controlAdmin:storage.confirmInboxAppBody"), label: t("controlAdmin:storage.confirmInboxAppLabel") }
          : { title: t("controlAdmin:storage.confirmInboxOffTitle"), body: t("controlAdmin:storage.confirmInboxOffBody", { name }), label: t("controlAdmin:storage.confirmInboxOffLabel") };
      case "house":
        if (switchTo.mode === "own") {
          return { title: t("controlAdmin:storage.confirmHouseOwnTitle", { name: picked }), body: t("controlAdmin:storage.confirmHouseOwnBody"), label: t("controlAdmin:storage.confirmHouseOwnLabel") };
        }
        // The nominated library of your own moves into App storage whole and stays
        // nominated; a new one is made only when none is nominated.
        if (switchTo.mode === "app" && view?.mode === "own" && view.library) {
          return {
            title: t("controlAdmin:storage.confirmHouseMoveTitle", { path: target }),
            body: t("controlAdmin:storage.confirmHouseMoveBody", { name }),
            label: t("controlAdmin:storage.confirmHouseMoveLabel")
          };
        }
        return switchTo.mode === "app"
          ? { title: t("controlAdmin:storage.confirmHouseAppTitle", { path: target }), body: t("controlAdmin:storage.confirmHouseAppBody"), label: t("controlAdmin:storage.confirmHouseAppLabel") }
          : { title: t("controlAdmin:storage.confirmHouseOffTitle", { name }), body: t("controlAdmin:storage.confirmHouseOffBody"), label: t("controlAdmin:storage.confirmHouseOffLabel") };
      case "backups":
        return {
          title: t(switchTo.mode === "app" ? "controlAdmin:storage.confirmBackupsAppTitle" : "controlAdmin:storage.confirmBackupsOwnTitle", { path: switchTo.mode === "app" ? target : view?.resolvedPath ?? "" }),
          body: t("controlAdmin:storage.confirmBackupsBody"),
          label: t("controlAdmin:storage.confirmBackupsLabel")
        };
    }
  };

  // ── The chooser's options per room ────────────────────────────────────────

  const chooserOptions = (room: RoomView): { mode: RoomMode; label: string; hint: string; disabled?: boolean }[] => {
    const appOption = {
      mode: "app" as const,
      label: t("controlAdmin:storage.optionApp"),
      hint: room.appPath ?? t("controlAdmin:storage.optionAppUnavailable"),
      disabled: !room.appPath
    };
    switch (room.room) {
      case "trash":
        return [appOption, { mode: "own", label: t("controlAdmin:storage.optionOwn"), hint: room.mode === "own" ? room.resolvedPath ?? "" : "" }, { mode: "off", label: t("controlAdmin:storage.optionOffTrash"), hint: "" }];
      case "inbox":
        return [appOption, { mode: "own", label: t("controlAdmin:storage.optionOwnLibrary"), hint: t("controlAdmin:storage.optionOwnLibraryHint") }, { mode: "off", label: t("controlAdmin:storage.optionOffInbox"), hint: "" }];
      case "house":
        return [appOption, { mode: "own", label: t("controlAdmin:storage.optionOwnLibrary"), hint: t("controlAdmin:storage.optionOwnLibraryHint") }, { mode: "off", label: t("controlAdmin:storage.optionOffHouse"), hint: "" }];
      case "thumbnails":
        return [appOption, { mode: "own", label: t("controlAdmin:storage.optionOwn"), hint: room.mode === "own" ? room.resolvedPath ?? "" : "" }];
      case "renders":
        return [appOption, { mode: "own", label: t("controlAdmin:storage.optionFollowThumbs"), hint: "" }];
      case "backups":
        return [appOption, { mode: "own", label: t("controlAdmin:storage.optionBackupPath"), hint: "" }];
    }
  };

  const chooserView = chooserRoom ? rooms.find((room) => room.room === chooserRoom) ?? null : null;
  const pendingCopy = pending ? confirmCopy(pending) : null;

  return (
    <>
      <ControlSectionHead
        section="storage"
        icon={<HardDrive size={30} />}
        iconClassName="storage"
        description={t("controlAdmin:storage.headDescription")}
      >
        <RefreshButton
          onRefresh={async () => {
            setError("");
            try {
              await loadStorage();
            } catch (err) {
              setError(err instanceof Error ? err.message : t("controlAdmin:storage.refreshFailed"));
              throw err;
            }
          }}
        />
      </ControlSectionHead>

      {error && <MessageBox tone="error" title={t("controlAdmin:storage.errorTitle")}>{error}</MessageBox>}

      <section className="storage-section">
        <div className="storage-section-head">
          <div>
            <h2>{t("controlAdmin:storage.containersTitle")}</h2>
            <p>{t("controlAdmin:storage.containersDesc")}</p>
          </div>
          <button
            className="primary-button"
            onClick={() => {
              setError("");
              setRootNameInput("");
              setRootPathInput("");
              setCreateStorageRootOpen(true);
            }}
            title={t("controlAdmin:storage.addContainerTitle")}
          >
            <Plus size={18} />
            <span>{t("controlAdmin:storage.addContainer")}</span>
          </button>
        </div>

        {storageRoots.length === 0 ? (
          <p className="management-empty">{t("controlAdmin:storage.noContainers")}</p>
        ) : (
          <div className="datagrid-wrap">
            <table className="datagrid">
              <thead>
                <tr>
                  <th>{t("controlAdmin:storage.thName")}</th>
                  <th>{t("controlAdmin:storage.thPath")}</th>
                  <th className="col-num">{t("controlAdmin:storage.thLibraries")}</th>
                  <th className="col-actions"></th>
                </tr>
              </thead>
              <tbody>
                {storageRoots.map((root) => (
                  <tr key={root.id}>
                    <td><strong>{root.name}</strong></td>
                    <td className="datagrid-muted storage-path-cell">{root.path}</td>
                    <td className="col-num">
                      {root.libraryCount > 0 ? (
                        <span className="count-badge">{root.libraryCount}</span>
                      ) : (
                        <span className="datagrid-muted">—</span>
                      )}
                    </td>
                    <td className="col-actions">
                      <button
                        className="text-button danger"
                        disabled={root.libraryCount > 0 || deletingRootId === root.id}
                        onClick={() => deleteStorageRoot(root)}
                        title={root.libraryCount > 0 ? t("controlAdmin:storage.deleteBlockedTitle") : undefined}
                      >
                        {deletingRootId === root.id ? t("controlAdmin:storage.deleting") : t("controlAdmin:storage.delete")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="library-settings-panel storage-settings-panel app-storage-panel">
        <div>
          <h2>{t("controlAdmin:storage.appTitle")}</h2>
          <p>{t("controlAdmin:storage.appDesc")}</p>
        </div>
        <div className="storage-path-summary">
          <strong>{storage?.path || t("controlAdmin:storage.appNotSet")}</strong>
        </div>
        <div className="library-settings-actions">
          {storage?.path && (
            storage.ready
              ? <span className="setting-status ready">{t("controlAdmin:storage.ready")}</span>
              : <span className="setting-status needs-attention">{storage.error || t("controlAdmin:storage.appNotReady")}</span>
          )}
          <div className="app-storage-buttons">
            {storage?.path && (
              <Button
                variant="text"
                disabled={anyMoving}
                title={anyMoving ? t("controlAdmin:storage.appMovingTitle") : undefined}
                onClick={() => { setAppError(""); setCarry({}); setAppPathPending(null); }}
              >
                {t("controlAdmin:storage.appClear")}
              </Button>
            )}
            <Button
              variant="secondary"
              compact
              disabled={anyMoving}
              title={anyMoving ? t("controlAdmin:storage.appMovingTitle") : undefined}
              onClick={() => { setAppError(""); setAppPickerOpen(true); }}
            >
              {storage?.path ? t("controlAdmin:storage.appChange") : t("controlAdmin:storage.appChoose")}
            </Button>
          </div>
        </div>

        {storage && (
          <div className="datagrid-wrap app-storage-rooms">
            <table className="datagrid">
              <thead>
                <tr>
                  <th>{t("controlAdmin:storage.thRoom")}</th>
                  <th>{t("controlAdmin:storage.thWhere")}</th>
                  <th className="col-actions"></th>
                </tr>
              </thead>
              <tbody>
                {rooms.map((room) => {
                  const where = whereText(room);
                  const count = countText(room);
                  const move = room.move;
                  const moveTotal = move.done + move.pending;
                  return (
                    <tr key={room.room}>
                      <td>
                        <strong>{roomName[room.room]}</strong>
                        <div className="datagrid-muted app-storage-hint">{roomHint[room.room]}</div>
                      </td>
                      <td className="storage-path-cell">
                        <code className="app-storage-path">{where.path}</code>
                        <div className="datagrid-muted app-storage-from">
                          {[where.from, count].filter(Boolean).join(" · ")}
                        </div>
                        {move.running && (
                          <div className="app-storage-move">
                            <span>{t("controlAdmin:storage.moving", { moved: move.done, total: moveTotal })}</span>
                            <Button variant="text" compact disabled={moveBusy} onClick={() => void moveAction("DELETE", room.room)}>
                              {t("controlAdmin:storage.moveCancel")}
                            </Button>
                          </div>
                        )}
                        {!move.running && move.failed.length > 0 && (
                          <div className="app-storage-move needs-attention">
                            <span title={move.failed.map((f) => `${f.title ?? f.name}: ${f.error}`).join("\n")}>
                              {t("controlAdmin:storage.moveFailed", { count: move.failed.length })}
                            </span>
                            <Button variant="text" compact disabled={moveBusy} onClick={() => void moveAction("POST", room.room)}>
                              {t("controlAdmin:storage.moveRetry")}
                            </Button>
                          </div>
                        )}
                      </td>
                      <td className="col-actions app-storage-actions">
                        <Button
                          variant="secondary"
                          compact
                          disabled={move.running}
                          title={move.running ? t("controlAdmin:recycleBin.locationLockedTitle") : undefined}
                          onClick={() => openChooser(room)}
                        >
                          {t("controlAdmin:storage.changeRoom")}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {appPickerOpen && (
        <FolderPickerModal
          title={t("controlAdmin:storage.pickAppTitle")}
          intro={t("controlAdmin:storage.pickAppIntro")}
          storageRoots={storageRoots}
          confirmLabel={t("controlAdmin:storage.useThisFolder")}
          onPick={({ absolutePath }) => {
            setAppPickerOpen(false);
            setCarry({});
            setAppPathPending(absolutePath);
          }}
          onClose={() => setAppPickerOpen(false)}
          onError={setError}
        />
      )}

      {appPathPending !== undefined && (
        <ConfirmDialog
          title={appPathPending
            ? t("controlAdmin:storage.confirmAppTitle", { path: appPathPending })
            : t("controlAdmin:storage.confirmClearTitle")}
          confirmLabel={appPathPending ? t("controlAdmin:storage.confirmAppLabel") : t("controlAdmin:storage.confirmClearLabel")}
          busyLabel={t("controlAdmin:ui.saving")}
          busy={savingApp}
          rich={roomsInUse.length > 0}
          error={appError || undefined}
          onConfirm={() => void saveAppPath()}
          onCancel={() => { setAppPathPending(undefined); setAppError(""); }}
        >
          {roomsInUse.length === 0 ? (
            appPathPending ? t("controlAdmin:storage.confirmAppBody") : t("controlAdmin:storage.confirmClearBody")
          ) : appPathPending ? (
            <>
              <p>{t("controlAdmin:storage.confirmAppRoomsIntro")}</p>
              <div className="app-storage-options">
                {roomsInUse.map((room) => {
                  const carried = carry[room.room] !== false;
                  return (
                    <label key={room.room} className="app-storage-option">
                      <input
                        type="checkbox"
                        checked={carried}
                        disabled={savingApp}
                        onChange={(event) => setCarry((prev) => ({ ...prev, [room.room]: event.target.checked }))}
                      />
                      <span>
                        <strong>{roomName[room.room]}</strong>
                        <small className="datagrid-muted">{carryCopy(room, carried)}</small>
                      </span>
                    </label>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <p>{t("controlAdmin:storage.confirmClearRoomsIntro")}</p>
              <ul className="app-storage-stays">
                {roomsInUse.map((room) => (
                  <li key={room.room}>
                    <strong>{roomName[room.room]}</strong>
                    <span className="datagrid-muted">{carryCopy(room, false)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </ConfirmDialog>
      )}

      {chooserView && (
        <Modal
          title={t("controlAdmin:storage.chooserTitle", { room: roomName[chooserView.room] })}
          className="app-storage-chooser"
          onClose={() => setChooserRoom(null)}
          onSubmit={(event) => { event.preventDefault(); continueFromChooser(); }}
        >
          <p>{roomHint[chooserView.room]}</p>
          <div className="app-storage-options">
            {chooserOptions(chooserView).map((option) => (
              <label key={option.mode} className={`app-storage-option${option.disabled ? " is-disabled" : ""}`}>
                <input
                  type="radio"
                  name="app-storage-mode"
                  value={option.mode}
                  checked={chooserMode === option.mode}
                  disabled={option.disabled}
                  onChange={() => setChooserMode(option.mode)}
                />
                <span>
                  <strong>{option.label}</strong>
                  {option.hint && <small className="datagrid-muted">{option.hint}</small>}
                </span>
              </label>
            ))}
          </div>
          {chooserMode === "own" && (chooserView.room === "inbox" || chooserView.room === "house") && (
            <SelectField
              label={t("controlAdmin:storage.libraryPickLabel")}
              value={chooserLibrary}
              onChange={setChooserLibrary}
              options={[
                { value: "", label: t("controlAdmin:storage.libraryPickNone") },
                ...(storage?.libraries ?? [])
                  .filter((library) => chooserView.room === "house" ? !library.inbox : true)
                  .map((library) => ({ value: library.id, label: library.inbox ? `${library.name} · ${t("controlAdmin:storage.roomInbox")}` : library.name }))
              ]}
            />
          )}
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setChooserRoom(null)} autoFocus>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={
                (chooserMode === chooserView.mode && chooserMode !== "own")
                || (chooserMode === "own" && (chooserView.room === "inbox" || chooserView.room === "house") && (!chooserLibrary || chooserLibrary === chooserView.library?.id))
              }
            >
              {t("controlAdmin:storage.continue")}
            </Button>
          </div>
        </Modal>
      )}

      {ownPickerRoom === "trash" && (
        <FolderPickerModal
          title={t("controlAdmin:storage.pickOwnTitle")}
          intro={t("controlAdmin:storage.pickOwnIntro")}
          storageRoots={storageRoots}
          confirmLabel={t("controlAdmin:storage.useThisFolder")}
          onPick={({ absolutePath }) => {
            setOwnPickerRoom(null);
            setPending({ room: "trash", mode: "own", path: absolutePath, libraryId: null });
          }}
          onClose={() => setOwnPickerRoom(null)}
          onError={setError}
        />
      )}

      {ownPickerRoom === "thumbnails" && (
        <Modal
          title={t("controlAdmin:storage.pickOwnTitle")}
          className="edit-thumbnail-modal"
          onClose={() => setOwnPickerRoom(null)}
          onSubmit={(event) => {
            event.preventDefault();
            if (!thumbsInput.trim()) return;
            setOwnPickerRoom(null);
            setPending({ room: "thumbnails", mode: "own", path: thumbsInput.trim(), libraryId: null });
          }}
        >
          <p>{t("controlAdmin:storage.pickThumbsIntro")}</p>
          <Field label={t("controlAdmin:storage.thumbPathLabel")} value={thumbsInput} onChange={setThumbsInput} />
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setOwnPickerRoom(null)} autoFocus>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" type="submit" disabled={!thumbsInput.trim()}>
              {t("controlAdmin:storage.continue")}
            </Button>
          </div>
        </Modal>
      )}

      {pending && pendingCopy && (
        <ConfirmDialog
          title={pendingCopy.title}
          confirmLabel={pendingCopy.label}
          busyLabel={t("controlAdmin:ui.saving")}
          busy={switching}
          error={switchError || undefined}
          onConfirm={() => void applySwitch()}
          onCancel={() => { setPending(null); setSwitchError(""); }}
        >
          {pendingCopy.body}
        </ConfirmDialog>
      )}

      {createStorageRootOpen && (
        <Modal
          title={t("controlAdmin:storage.addContainerTitle")}
          className="create-storage-modal"
          busy={savingStorageRoot}
          onClose={() => setCreateStorageRootOpen(false)}
          onSubmit={createStorageRoot}
        >
            <p>{t("controlAdmin:storage.containerModalIntro")}</p>
            <Field label={t("controlAdmin:storage.containerName")} value={rootNameInput} onChange={setRootNameInput} />
            <Field label={t("controlAdmin:storage.containerPath")} value={rootPathInput} onChange={setRootPathInput} />
            {error && <MessageBox tone="error" title={t("controlAdmin:storage.addContainerFailedTitle")}>{error}</MessageBox>}
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setCreateStorageRootOpen(false)} disabled={savingStorageRoot} autoFocus>
                {t("common.cancel")}
              </Button>
              <Button variant="primary" type="submit" disabled={savingStorageRoot}>
                {savingStorageRoot ? t("controlAdmin:ui.saving") : t("controlAdmin:storage.saveContainer")}
              </Button>
            </div>
        </Modal>
      )}
    </>
  );
}
