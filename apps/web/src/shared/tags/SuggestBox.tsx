import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Search, X } from "lucide-react";
import { Button } from "../Button";

// A search box with a list under it: how a tag goes on anything (TagEditor,
// BulkTagEditor) and how a person goes on a photo in the lightbox
// (LightboxPeoplePicker). It replaced browser <datalist>s, a comma-separated text
// field and a generic combobox, so every one of those reads the same way.
//
// The list works as Review mode's "Who is in it?" does (review/PeopleChips): the
// most-used entries before anything is typed, then names starting with what was
// typed ahead of names containing it, and a name nothing has yet offered as a new
// one, last. ↑/↓ move, Enter picks; the first Escape clears, the second closes.
// The box stays open after a pick, so a whole group goes on in one go.
//
// It paints with the theme tokens (--field, --line, --ink, --muted), so it sits in a
// dialog as it is; the lightbox panel restates those tokens to its dark palette.
// Without `onClose` the box is there for good — no close button, and an Escape on
// an empty box is left to whatever it sits in (a dialog closes).

export interface SuggestItem {
  id: string;
  name: string;
  /** How much it is used — the idle order, and the tie-break while typing. */
  weight: number;
  avatar: ReactNode;
  /** A short fact at the row's end ("11 photos"). */
  detail?: string;
}

export type SuggestChoice = { id: string; name: string } | { name: string };

/** Entries shown before anything is typed. */
const IDLE = 6;
/** Matches shown while typing. */
const MATCHES = 8;

type Row = { kind: "item"; item: SuggestItem } | { kind: "new"; name: string };

export function SuggestBox({
  items,
  takenNames,
  busy,
  placeholder,
  ariaLabel,
  listLabel,
  emptyHint,
  newLabel,
  onPick,
  onClose,
  autoFocus = true
}: {
  /** What can be picked — already without what is on the thing. */
  items: SuggestItem[];
  /** Names on the thing already; typing one is not offered as new. */
  takenNames: string[];
  busy: boolean;
  placeholder: string;
  ariaLabel: string;
  listLabel: string;
  /** Under the box when there is nothing to offer yet. */
  emptyHint?: string;
  newLabel: (name: string) => string;
  /** Resolves true when it went on, which clears the box for the next one. */
  onPick: (choice: SuggestChoice) => Promise<boolean>;
  /** Without it the box has no close button and never closes itself. */
  onClose?: () => void;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation(["common"]);
  const listId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const trimmed = query.trim();
  const needle = trimmed.toLowerCase();
  const matches = needle
    ? items
      .filter((item) => item.name.toLowerCase().includes(needle))
      .sort((a, b) =>
        Number(!a.name.toLowerCase().startsWith(needle)) - Number(!b.name.toLowerCase().startsWith(needle))
        || b.weight - a.weight)
      .slice(0, MATCHES)
    : [...items].sort((a, b) => b.weight - a.weight).slice(0, IDLE);
  const exists = [...items.map((item) => item.name), ...takenNames].some((name) => name.toLowerCase() === needle);
  const rows: Row[] = [
    ...matches.map((item) => ({ kind: "item", item }) as Row),
    ...(trimmed && !exists ? [{ kind: "new", name: trimmed } as Row] : [])
  ];
  const current = Math.min(active, Math.max(rows.length - 1, 0));

  const choose = async (row: Row) => {
    const ok = await onPick(row.kind === "item" ? { id: row.item.id, name: row.item.name } : { name: row.name });
    if (ok) { setQuery(""); setActive(0); }
  };

  const rowId = (index: number) => `${listId}-${index}`;

  return (
    <div className="suggest-box">
      <div className="suggest-box-search">
        <Search size={15} aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && rows.length > 0) { event.preventDefault(); setActive((current + 1) % rows.length); }
            else if (event.key === "ArrowUp" && rows.length > 0) { event.preventDefault(); setActive((current - 1 + rows.length) % rows.length); }
            else if (event.key === "Enter") {
              // Never the surrounding form's submit: Enter here means "this one".
              event.preventDefault();
              if (!busy && rows[current]) void choose(rows[current]);
            } else if (event.key === "Escape" && (query || onClose)) {
              event.stopPropagation();
              if (query) setQuery(""); else onClose?.();
            }
          }}
          placeholder={placeholder}
          maxLength={120}
          disabled={busy}
          autoFocus={autoFocus}
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={rows.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={rows.length > 0 ? rowId(current) : undefined}
        />
        {onClose && (
          <Button
            variant="bare"
            className="suggest-box-close"
            onClick={onClose}
            aria-label={t("common:common.close")}
            title={t("common:common.close")}
          >
            <X size={14} aria-hidden="true" />
          </Button>
        )}
      </div>

      {rows.length > 0 ? (
        <div className="suggest-box-list" id={listId} role="listbox" aria-label={listLabel}>
          {rows.map((row, index) => (
            <Button
              key={row.kind === "item" ? row.item.id : "new"}
              id={rowId(index)}
              variant="bare"
              role="option"
              aria-selected={index === current}
              className={`suggest-box-row${index === current ? " is-active" : ""}${row.kind === "new" ? " is-new" : ""}`}
              // Keep the caret in the box: the next one can be typed straight away.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => void choose(row)}
              disabled={busy}
            >
              {row.kind === "item" ? (
                <>
                  <span className="suggest-box-avatar" aria-hidden="true">{row.item.avatar}</span>
                  <span className="suggest-box-name">{row.item.name}</span>
                  {row.item.detail && <small className="suggest-box-detail">{row.item.detail}</small>}
                </>
              ) : (
                <>
                  <span className="suggest-box-avatar is-new" aria-hidden="true"><Plus size={14} /></span>
                  <span className="suggest-box-name">{newLabel(row.name)}</span>
                </>
              )}
            </Button>
          ))}
        </div>
      ) : (
        !trimmed && emptyHint && <p className="suggest-box-empty">{emptyHint}</p>
      )}
    </div>
  );
}
