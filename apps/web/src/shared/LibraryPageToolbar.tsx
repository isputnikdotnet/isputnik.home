import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlphabetBar, AlphabetMenu, useAlphabetStrip, type AlphabetProps } from "./AlphabetBar";

// The one toolbar every browse page wears, directly under LibraryPageHeader.
// Audiobooks, Ebooks, Gallery and the list pages they link to (Authors,
// Narrators, Series, Albums…) all showed the same row — a scope picker left,
// compact 44px squares right — and each carried its own copy of the markup, plus
// a second bar below it during edit mode.
//
// The row has a fixed shape and pages fill slots rather than arranging their own:
//
//   scope · A–Z · tools ─── or, while selecting: "N selected" · selection.actions
//   ────────────────────────────────────────────────────────────────────────
//   strip (the A–Z strip, or the page's own second row)
//
// Above the phone breakpoint the toolbar shares one line with the page header
// (title · search · tools, library-browse.css) and drops its card; it takes a
// line and a card of its own again when it has a second row or a selection.
//
// Things it does that a page shouldn't have to remember:
//
//   * Edit mode REPLACES the tools inside this card instead of adding a bar
//     under it, so nothing below the toolbar moves when a selection starts.
//   * While selecting, the card pins to the top of the viewport, which is the
//     behaviour the old standalone bulk bar had.
//   * `alphabet` becomes the A–Z menu at the head of the tools, plus the strip
//     on a phone or wherever this browser asked for it (useAlphabetStrip).
//
// The tools themselves are the page's own controls (FilterButton, the sort menu,
// Select, …) — this component only sizes and orders them.
export function LibraryPageToolbar({
  scope,
  tools,
  selection,
  alphabet,
  strip,
  className
}: {
  /** Left slot: the library picker, a media-kind toggle, whatever scopes the page. */
  scope?: ReactNode;
  /** Right slot: compact filter/sort/select controls, in that order. */
  tools?: ReactNode;
  /** Edit mode. When set, it takes the right slot and the toolbar pins itself. */
  selection?: { count: number; actions: ReactNode } | null;
  /** The page's A–Z index: the server's letters facet and the chosen letter. */
  alphabet?: AlphabetProps;
  /** A second row of the page's own (the Inbox's deliveries, Family's tags).
   *  Falsy renders no row at all, so the card stays one line. */
  strip?: ReactNode;
  className?: string;
}) {
  const { t } = useTranslation(["common"]);
  const [alphabetStrip, setAlphabetStrip] = useAlphabetStrip();
  const selecting = selection != null;
  const letters = alphabet && alphabet.available.length > 0;
  const showsStrip = Boolean(strip) || (letters && alphabetStrip);
  return (
    <div className={["library-toolbar", selecting ? "is-selecting" : "", showsStrip ? "has-strip" : "", className].filter(Boolean).join(" ")}>
      <div className="library-toolbar-row">
        <div className="library-toolbar-scope">{scope}</div>
        {selecting ? (
          <div className="library-toolbar-tools is-selection">
            <span className="library-toolbar-count">{t("common.selectedCount", { count: selection.count })}</span>
            <div className="row-actions library-toolbar-selection-actions">{selection.actions}</div>
          </div>
        ) : (
          (tools || letters) && (
            <div className="library-toolbar-tools">
              {letters && (
                <span className="library-toolbar-az">
                  <AlphabetMenu {...alphabet} strip={alphabetStrip} onStripChange={setAlphabetStrip} />
                </span>
              )}
              {tools}
            </div>
          )
        )}
      </div>
      {strip ? (
        <div className="library-toolbar-strip">{strip}</div>
      ) : letters && (
        // Always rendered, so a phone has it whatever a wide screen chose; the
        // stylesheet folds it away above the breakpoint unless it was asked for.
        <div className={["library-toolbar-strip", "is-alphabet", alphabetStrip ? "" : "is-folded"].filter(Boolean).join(" ")}>
          <AlphabetBar {...alphabet} />
        </div>
      )}
    </div>
  );
}
