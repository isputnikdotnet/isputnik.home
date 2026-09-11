import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import type { AudiobookBook } from "../types";

// The ⋯ on a catalog tile: edit details / delete, for whoever may.
export function CatalogAdminMenu({
  book,
  canEdit,
  canDelete,
  onEdit,
  onDelete
}: {
  book: AudiobookBook;
  canEdit: boolean;
  canDelete: boolean;
  onEdit: (book: AudiobookBook) => void;
  onDelete: (book: AudiobookBook) => void;
}) {
  const { t } = useTranslation(["common", "book"]);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", dismiss);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", dismiss);
    };
  }, [open]);

  if (!canEdit && !canDelete) return null;

  return (
    <div
      ref={menuRef}
      className="audiobook-catalog-menu-wrap"
      onClick={(event) => event.stopPropagation()}
    >
      <button
        className="audiobook-catalog-action admin"
        type="button"
        onClick={() => setOpen((isOpen) => !isOpen)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("book:catalog.moreActionsAria", { title: book.title })}
        title={t("book:catalog.moreActionsTitle")}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
        <span>{t("book:catalog.moreActionsTitle")}</span>
      </button>
      {open && (
        <div
          className="book-detail-action-menu book-progress-menu audiobook-catalog-admin-menu"
          role="menu"
          aria-label={t("book:catalog.moreActionsAria", { title: book.title })}
        >
          {canEdit && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onEdit(book);
              }}
            >
              <Pencil size={16} aria-hidden="true" />
              <span>{t("book:catalog.editDetails")}</span>
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              role="menuitem"
              className="danger"
              onClick={() => {
                setOpen(false);
                onDelete(book);
              }}
            >
              <Trash2 size={16} aria-hidden="true" />
              <span>{t("book:catalog.delete")}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
