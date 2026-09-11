import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../api";
import type { GalleryLibrary } from "../types";

export interface FolderMovePlan {
  items: number;
  to: string;
  targetName: string;
}

// An admin's actions on the folder open in the Folders view: rescan it, lock it
// against deletion, or move it into another gallery library. Each needs exactly
// one library in scope — a folder path is only unique within one.
export function useFolderAdmin({
  soleLibraryId,
  parent,
  parentLocked,
  setParentLocked,
  libraries,
  setError,
  setNotice,
  loadFolder
}: {
  soleLibraryId: string | null;
  parent: string;
  parentLocked: boolean;
  setParentLocked: (locked: boolean) => void;
  libraries: GalleryLibrary[];
  setError: (message: string) => void;
  setNotice: (message: string) => void;
  loadFolder: (parent: string) => Promise<void>;
}) {
  const { t } = useTranslation(["common", "gallery"]);

  // Rescan just the folder currently open. The scan runs on the server; progress
  // shows on Control panel → Overview → Tasks.
  const [folderRescanBusy, setFolderRescanBusy] = useState(false);
  const rescanFolder = useCallback(async () => {
    if (!soleLibraryId || !parent) return;
    setFolderRescanBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/api/library/gallery-libraries/${soleLibraryId}/rescan`, {
        method: "POST",
        body: JSON.stringify({ folder: parent })
      });
      setNotice(t("gallery:folders.rescanNotice", { folder: parent }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:folders.errors.rescan"));
    } finally {
      setFolderRescanBusy(false);
    }
  }, [soleLibraryId, parent]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lock or unlock the folder currently open. Locked = nothing at or below it can
  // be deleted from the app (the server refuses, whoever asks).
  const [folderLockBusy, setFolderLockBusy] = useState(false);
  const toggleFolderLock = useCallback(async () => {
    if (!soleLibraryId || !parent) return;
    setFolderLockBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/api/library/libraries/${soleLibraryId}/folder-locks`, {
        method: "PUT",
        body: JSON.stringify({ folderPath: parent, locked: !parentLocked })
      });
      setParentLocked(!parentLocked);
      setNotice(!parentLocked
        ? t("gallery:folders.lockedNotice", { folder: parent })
        : t("gallery:folders.unlockedNotice", { folder: parent }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:folders.errors.toggleLock"));
    } finally {
      setFolderLockBusy(false);
    }
  }, [soleLibraryId, parent, parentLocked]); // eslint-disable-line react-hooks/exhaustive-deps

  // Move the folder currently open into another gallery library. The files travel
  // as a storage move task; the items keep their ids, so nothing that names them
  // breaks. Picking a target asks the server what would happen (a dry run) before
  // the verb.
  const [moveFolderOpen, setMoveFolderOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState("");
  const [movePlan, setMovePlan] = useState<FolderMovePlan | null>(null);
  const [moveBusy, setMoveBusy] = useState(false);
  const [moveError, setMoveError] = useState("");
  const moveTargets = useMemo(
    () => libraries.filter((library) => library.id !== soleLibraryId && !library.inbox && library.canWrite),
    [libraries, soleLibraryId]
  );
  const openMoveFolder = () => {
    setMoveTarget("");
    setMovePlan(null);
    setMoveError("");
    setMoveFolderOpen(true);
  };
  const planMoveFolder = useCallback(async (targetLibraryId: string) => {
    setMoveTarget(targetLibraryId);
    setMovePlan(null);
    setMoveError("");
    if (!soleLibraryId || !parent || !targetLibraryId) return;
    try {
      const { plan } = await api<{ plan: { items: number; to: string; target: { name: string } } }>(
        `/api/library/gallery-libraries/${soleLibraryId}/folders/move`,
        { method: "POST", body: JSON.stringify({ folderPath: parent, targetLibraryId, dryRun: true }) }
      );
      setMovePlan({ items: plan.items, to: plan.to, targetName: plan.target.name });
    } catch (err) {
      setMoveError(err instanceof Error ? err.message : t("gallery:folders.errors.move"));
    }
  }, [soleLibraryId, parent]); // eslint-disable-line react-hooks/exhaustive-deps
  const confirmMoveFolder = useCallback(async () => {
    if (!soleLibraryId || !parent || !moveTarget) return;
    setMoveBusy(true);
    setMoveError("");
    const folder = parent;
    const sourceLibraryId = soleLibraryId;
    try {
      await api(`/api/library/gallery-libraries/${sourceLibraryId}/folders/move`, {
        method: "POST",
        body: JSON.stringify({ folderPath: folder, targetLibraryId: moveTarget })
      });
      setMoveFolderOpen(false);
      setNotice(t("gallery:folders.moveQueuedNotice", { folder, library: movePlan?.targetName ?? "" }));
      // Watch the task; when it is done, open the folder above, since this one
      // is gone from here, and say so.
      const above = folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "";
      const watch = window.setInterval(() => {
        void api<{ moves: { running: boolean; libraryId: string | null; folder: string | null; status: string; failed: { name: string; error: string }[] }[] }>("/api/library/gallery/folder-moves")
          .then((payload) => {
            const mine = payload.moves.find((move) => move.libraryId === sourceLibraryId && move.folder === folder);
            if (!mine || mine.running) return;
            window.clearInterval(watch);
            if (mine.status === "completed") {
              setNotice(t("gallery:folders.moveDoneNotice", { folder, library: movePlan?.targetName ?? "" }));
            } else {
              setError(t("gallery:folders.errors.moveFailed", { folder, count: mine.failed.length }));
            }
            void loadFolder(above);
          })
          .catch(() => { /* next tick */ });
      }, 2000);
    } catch (err) {
      setMoveError(err instanceof Error ? err.message : t("gallery:folders.errors.move"));
    } finally {
      setMoveBusy(false);
    }
  }, [soleLibraryId, parent, moveTarget, movePlan, loadFolder]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    folderRescanBusy, rescanFolder,
    folderLockBusy, toggleFolderLock,
    moveFolderOpen, setMoveFolderOpen, moveTarget, movePlan, moveBusy, moveError, moveTargets,
    openMoveFolder, planMoveFolder, confirmMoveFolder
  };
}
