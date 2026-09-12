import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ChevronDown, Compass, Library, Mic2, Shapes, UserRound } from "lucide-react";
import { navigate } from "../../../router";
import { useAnchoredMenu } from "../../../shared/useAnchoredMenu";
import { CATALOG_KINDS, type CatalogKind } from "./catalogKinds";
import { Button } from "../../../shared/Button";

// The phone's "Browse" dropdown on a catalog page, standing in for the section
// nav: Authors, Narrators (audiobooks only), Series and Categories.
export function CatalogBrowseMenu({ kind }: { kind: CatalogKind }) {
  const { t } = useTranslation(["common", "book"]);
  // Destructured, like every other caller: reading the hook's object property by
  // property in render is what react-hooks/refs objects to (the object carries the
  // two refs), and the properties are the same values either way.
  const { open, pos, toggle, close, triggerRef, menuRef } = useAnchoredMenu({ closeOnEscape: false });
  const go = (path: string) => { close(); navigate(path); };

  return (
    <div className="audiobook-library-shortcuts">
      <Button
        variant="bare"
        ref={triggerRef}
        className="audiobook-library-tab"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t(CATALOG_KINDS[kind].keys.browseAria)}
      >
        <Compass size={19} aria-hidden="true" />
        <span>{t("book:catalog.browse")}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </Button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="book-detail-action-menu audiobook-library-menu"
          role="menu"
          aria-label={t("book:catalog.browse")}
          style={{ position: "fixed", top: pos.top, left: pos.left ?? undefined, right: pos.right ?? undefined }}
        >
          <Button variant="bare" role="menuitem" onClick={() => go("/authors")}>
            <UserRound size={16} aria-hidden="true" />
            <span>{t("book:catalog.browseAuthors")}</span>
          </Button>
          {kind === "audiobook" && (
            <Button variant="bare" role="menuitem" onClick={() => go("/audiobooks/narrators")}>
              <Mic2 size={16} aria-hidden="true" />
              <span>{t("book:catalog.browseNarrators")}</span>
            </Button>
          )}
          <Button variant="bare" role="menuitem" onClick={() => go(kind === "ebook" ? "/ebooks/series" : "/audiobooks/series")}>
            <Library size={16} aria-hidden="true" />
            <span>{t("book:catalog.browseSeries")}</span>
          </Button>
          <Button variant="bare" role="menuitem" onClick={() => go("/categories")}>
            <Shapes size={16} aria-hidden="true" />
            <span>{t("book:catalog.browseCategories")}</span>
          </Button>
        </div>,
        document.body
      )}
    </div>
  );
}
