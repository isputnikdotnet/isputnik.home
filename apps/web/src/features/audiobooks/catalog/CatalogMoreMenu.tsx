import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { MoreHorizontal } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useAnchoredMenu } from "../../../shared/useAnchoredMenu";
import { Button } from "../../../shared/Button";

export interface CatalogMoreItem {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}

// The phone toolbar's ⋮: how the list is drawn (rows or covers), picking several
// books, and Upload. They are all one-off actions on a screen with room for
// three controls, and Browse · Filter · Sort earn those three.
export function CatalogMoreMenu({ items }: { items: CatalogMoreItem[] }) {
  const { t } = useTranslation(["common", "book"]);
  const { open, pos, toggle, close, triggerRef, menuRef } = useAnchoredMenu();

  if (items.length === 0) return null;

  return (
    <>
      <Button
        variant="toolbar"
        ref={triggerRef}
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("book:catalog.moreActions")}
        title={t("book:catalog.moreActions")}
      >
        <MoreHorizontal size={18} aria-hidden="true" />
      </Button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="book-detail-action-menu audiobook-library-menu"
          role="menu"
          aria-label={t("book:catalog.moreActions")}
          style={{ position: "fixed", top: pos.top, left: pos.left ?? undefined, right: pos.right ?? undefined }}
        >
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <Button variant="bare" key={item.label} role="menuitem" onClick={() => { close(); item.onClick(); }}>
                <Icon size={16} aria-hidden="true" />
                <span>{item.label}</span>
              </Button>
            );
          })}
        </div>,
        document.body
      )}
    </>
  );
}
