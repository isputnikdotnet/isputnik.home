import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Search, X } from "lucide-react";
import { Button } from "../../shared/Button";

// A search box with a list under it, in the lightbox panel's dark palette: how the
// Details tab adds a person (LightboxPeoplePicker) and a tag (LightboxTagPicker).
// It replaced browser <datalist>s and a comma-separated text field.
//
// The list works as Review mode's "Who is in it?" does (review/PeopleChips): the
// most-used entries before anything is typed, then names starting with what was
// typed ahead of names containing it, and a name nothing has yet offered as a new
// one, last. ↑/↓ move, Enter picks; the first Escape clears, the second closes.
// The box stays open after a pick, so a whole group goes on in one go.

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

export function LightboxSuggestBox({
  items,
  takenNames,
  busy,
  placeholder,
  ariaLabel,
  listLabel,
  emptyHint,
  newLabel,
  onPick,
  onClose
}: {
  /** What can be picked — already without what is on the photo. */
  items: SuggestItem[];
  /** Names on the photo already; typing one is not offered as new. */
  takenNames: string[];
  busy: boolean;
  placeholder: string;
  ariaLabel: string;
  listLabel: string;
  /** Under the box when there is nothing to offer yet — for a photo with nothing on it. */
  emptyHint?: string;
  newLabel: (name: string) => string;
  /** Resolves true when it went on, which clears the box for the next one. */
  onPick: (choice: SuggestChoice) => Promise<boolean>;
  onClose: () => void;
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
    <div className="lb-suggest">
      <div className="lb-suggest-search">
        <Search size={15} aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && rows.length > 0) { event.preventDefault(); setActive((current + 1) % rows.length); }
            else if (event.key === "ArrowUp" && rows.length > 0) { event.preventDefault(); setActive((current - 1 + rows.length) % rows.length); }
            else if (event.key === "Enter") {
              event.preventDefault();
              if (!busy && rows[current]) void choose(rows[current]);
            } else if (event.key === "Escape") {
              event.stopPropagation();
              if (query) setQuery(""); else onClose();
            }
          }}
          placeholder={placeholder}
          maxLength={120}
          disabled={busy}
          autoFocus
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={rows.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={rows.length > 0 ? rowId(current) : undefined}
        />
        <Button
          variant="bare"
          className="lb-suggest-close"
          onClick={onClose}
          aria-label={t("common:common.close")}
          title={t("common:common.close")}
        >
          <X size={14} aria-hidden="true" />
        </Button>
      </div>

      {rows.length > 0 ? (
        <div className="lb-suggest-list" id={listId} role="listbox" aria-label={listLabel}>
          {rows.map((row, index) => (
            <Button
              key={row.kind === "item" ? row.item.id : "new"}
              id={rowId(index)}
              variant="bare"
              role="option"
              aria-selected={index === current}
              className={`lb-suggest-row${index === current ? " is-active" : ""}${row.kind === "new" ? " is-new" : ""}`}
              // Keep the caret in the box: the next one can be typed straight away.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => void choose(row)}
              disabled={busy}
            >
              {row.kind === "item" ? (
                <>
                  <span className="lb-suggest-avatar" aria-hidden="true">{row.item.avatar}</span>
                  <span className="lb-suggest-name">{row.item.name}</span>
                  {row.item.detail && <small className="lb-suggest-detail">{row.item.detail}</small>}
                </>
              ) : (
                <>
                  <span className="lb-suggest-avatar is-new" aria-hidden="true"><Plus size={14} /></span>
                  <span className="lb-suggest-name">{newLabel(row.name)}</span>
                </>
              )}
            </Button>
          ))}
        </div>
      ) : (
        !trimmed && emptyHint && <p className="lb-suggest-empty">{emptyHint}</p>
      )}
    </div>
  );
}
