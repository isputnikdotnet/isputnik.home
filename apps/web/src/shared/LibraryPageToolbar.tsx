import type { ReactNode } from "react";

// The one toolbar every browse page wears, directly under LibraryPageHeader.
// Audiobooks, Ebooks, Gallery and the list pages they link to (Authors,
// Narrators, Series, Albums…) all showed the same row — a scope picker left,
// compact 44px squares right — and each carried its own copy of the markup, plus
// a second bar below it during edit mode.
//
// The row has a fixed shape and pages fill slots rather than arranging their own:
//
//   scope · tools ─── or, while selecting: "N selected" · selection.actions
//   ────────────────────────────────────────────────────────────────────────
//   strip (the A–Z index)
//
// Two things it does that a page shouldn't have to remember:
//
//   * Edit mode REPLACES the tools inside this card instead of adding a bar
//     under it, so nothing below the toolbar moves when a selection starts.
//   * While selecting, the card pins to the top of the viewport, which is the
//     behaviour the old standalone bulk bar had.
//
// The tools themselves are the page's own controls (FilterButton, the sort menu,
// Select, …) — this component only sizes and orders them.
export function LibraryPageToolbar({
  scope,
  tools,
  selection,
  strip,
  className
}: {
  /** Left slot: the library picker, a media-kind toggle, whatever scopes the page. */
  scope?: ReactNode;
  /** Right slot: compact filter/sort/select controls, in that order. */
  tools?: ReactNode;
  /** Edit mode. When set, it takes the right slot and the toolbar pins itself. */
  selection?: { count: number; actions: ReactNode } | null;
  /** Second row inside the card — the A–Z strip today. Falsy renders no row at
   *  all (pages drop it on the phone), so the card stays one line. */
  strip?: ReactNode;
  className?: string;
}) {
  const selecting = selection != null;
  return (
    <div className={["library-toolbar", selecting ? "is-selecting" : "", className].filter(Boolean).join(" ")}>
      <div className="library-toolbar-row">
        <div className="library-toolbar-scope">{scope}</div>
        {selecting ? (
          <div className="library-toolbar-tools is-selection">
            <span className="library-toolbar-count">{selection.count} selected</span>
            <div className="row-actions library-toolbar-selection-actions">{selection.actions}</div>
          </div>
        ) : (
          tools && <div className="library-toolbar-tools">{tools}</div>
        )}
      </div>
      {strip && <div className="library-toolbar-strip">{strip}</div>}
    </div>
  );
}
