import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../api";
import type { CatalogKindConfig } from "./catalogKinds";

// Select mode on a catalog page: which books are ticked, which bulk dialog is open,
// and what each bulk action sends. Every action reports back through `onNotice`
// and ends the selection on success; `onChanged` re-reads what they changed
// (`onDeleted` after a bulk delete, which may also change the library counts).
export function useCatalogSelection({
  config,
  libraryId,
  onNotice,
  onChanged,
  onDeleted
}: {
  config: CatalogKindConfig;
  /** The one library in scope, or "all" — series live in a single library. */
  libraryId: string;
  onNotice: (message: string) => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation(["common", "book"]);
  const [active, setActive] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [seriesOpen, setSeriesOpen] = useState(false);
  const [editionsOpen, setEditionsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const toggle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = (ids: string[]) => setSelectedIds(new Set(ids));

  const exit = () => {
    setActive(false);
    setSelectedIds(new Set());
    setBulkOpen(false);
    setSeriesOpen(false);
    setEditionsOpen(false);
    setDeleteOpen(false);
  };

  const openDelete = () => { setDeleteError(""); setDeleteOpen(true); };

  // Group the selected books into one work (editions of the same title).
  const submitGroupEditions = async (primaryItemId: string) => {
    const result = await api<{ work: { id: string }; count: number }>(
      "/api/library/works",
      { method: "POST", body: JSON.stringify({ itemIds: [...selectedIds], primaryItemId }) }
    );
    onNotice(t("book:catalog.groupedEditionsNotice", { count: result.count }));
    onChanged();
    exit();
  };

  const submitAddToSeries = async (target: { seriesId: string } | { newName: string }) => {
    let seriesId: string;
    if ("seriesId" in target) {
      seriesId = target.seriesId;
    } else {
      const created = await api<{ series: { id: string } }>(
        `/api/library/${config.librariesPath}/${libraryId}/series`,
        { method: "POST", body: JSON.stringify({ name: target.newName }) }
      );
      seriesId = created.series.id;
    }
    const result = await api<{ added: number; skipped: number }>(
      `/api/library/series/${seriesId}/books`,
      { method: "POST", body: JSON.stringify({ bookIds: [...selectedIds] }) }
    );
    const parts = [t("book:catalog.addedToSeriesNotice", { count: result.added })];
    if (result.skipped > 0) parts.push(t("book:catalog.skippedAlreadyInSeries", { count: result.skipped }));
    onNotice(parts.join(" · "));
    onChanged();
    exit();
  };

  const submitBulk = async (fields: Record<string, unknown>) => {
    const result = await api<{ updated: number; forbidden: number; missing: number }>(
      "/api/library/books/bulk-metadata",
      { method: "POST", body: JSON.stringify({ bookIds: [...selectedIds], ...fields }) }
    );
    const parts = [t(config.keys.updatedNotice, { count: result.updated })];
    if (result.forbidden > 0) parts.push(t("book:catalog.skippedNoWriteAccess", { count: result.forbidden }));
    if (result.missing > 0) parts.push(t("book:catalog.skippedNotFound", { count: result.missing }));
    onNotice(parts.join(" · "));
    onChanged();
    exit();
  };

  const confirmDelete = async () => {
    setDeleteBusy(true);
    setDeleteError("");
    try {
      const result = await api<{ deleted: number; forbidden: number; missing: number; failed: number; error?: string }>(
        "/api/library/books/bulk-delete",
        { method: "POST", body: JSON.stringify({ bookIds: [...selectedIds] }) }
      );
      const parts = [t(config.keys.movedToRecycleNotice, { count: result.deleted })];
      if (result.forbidden > 0) parts.push(t("book:catalog.skippedNoDeleteAccess", { count: result.forbidden }));
      if (result.missing > 0) parts.push(t("book:catalog.skippedNotFound", { count: result.missing }));
      if (result.failed > 0) parts.push(result.error
        ? t("book:catalog.failedWithReason", { count: result.failed, error: result.error })
        : t("book:catalog.failed", { count: result.failed }));
      onNotice(parts.join(" · "));
      exit();
      onDeleted();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t(config.keys.unableMoveSelected));
    } finally {
      setDeleteBusy(false);
    }
  };

  return {
    active, enter: () => setActive(true), exit,
    selectedIds, toggle, selectAll,
    bulkOpen, setBulkOpen,
    seriesOpen, setSeriesOpen,
    editionsOpen, setEditionsOpen,
    deleteOpen, setDeleteOpen, openDelete, deleteBusy, deleteError,
    submitBulk, submitAddToSeries, submitGroupEditions, confirmDelete
  };
}
