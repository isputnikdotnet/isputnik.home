import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, History, MapPin, Search, X } from "lucide-react";
import { Button } from "./Button";

// A place in her own words, with a pin when the words name a town.
//
// Typing is always allowed — "Ukraine", a village the places database doesn't
// hold, a parish — and typed words carry no pin. Picking a suggestion fills the
// words AND the pin. Changing the words afterwards drops the pin, which named the
// old words. Where suggestions come from is the caller's: `load("")` fills the
// dropdown (the chevron), `load(text)` answers typing.
//
// When typing finds nothing, a line under the box says so — and that what she
// typed is kept as written — or that there is no place list to search at all,
// so an empty dropdown never reads as the field being broken.

export interface PlacePin {
  lat: number;
  lng: number;
}

export interface PlaceLoadResult {
  options: PlaceOption[];
  /** False when there is nothing to search (no places database). */
  available: boolean;
}

export interface PlaceOption {
  label: string;
  pin: PlacePin | null;
  /** "known" = already used nearby (drawn with a history mark), "town" = found. */
  kind: "known" | "town";
}

const SUGGEST_DELAY_MS = 250;

export function PlaceField({
  label,
  value,
  pin,
  onChange,
  load,
  placeholder,
  className
}: {
  label: string;
  value: string;
  pin: PlacePin | null;
  onChange: (value: string, pin: PlacePin | null) => void;
  load: (query: string) => Promise<PlaceLoadResult>;
  placeholder?: string;
  className?: string;
}) {
  const { t } = useTranslation("common");
  const inputId = useId();
  const listId = useId();
  const [open, setOpen] = useState(false);
  // The text the list answers: null = closed, "" = the chevron's full list.
  const [query, setQuery] = useState<string | null>(null);
  const [options, setOptions] = useState<PlaceOption[]>([]);
  // What the last finished search found nothing for, and why.
  const [empty, setEmpty] = useState<{ query: string; available: boolean } | null>(null);
  const [active, setActive] = useState(-1);
  const request = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (query === null) return;
    const id = ++request.current;
    const timer = window.setTimeout(() => {
      load(query)
        .then((found) => {
          if (request.current !== id) return;
          setOptions(found.options);
          setEmpty(found.options.length === 0 ? { query, available: found.available } : null);
          setActive(-1);
          setOpen(true);
        })
        .catch(() => { if (request.current === id) { setOptions([]); setEmpty(null); } });
    }, query ? SUGGEST_DELAY_MS : 0);
    return () => window.clearTimeout(timer);
  }, [query, load]);

  const close = () => {
    request.current += 1;
    setQuery(null);
    setOpen(false);
    setActive(-1);
    setEmpty(null);
  };

  const pick = (option: PlaceOption) => {
    onChange(option.label, option.pin);
    close();
  };

  const shown = open && options.length > 0;

  return (
    <div className={["field", "place-field", className].filter(Boolean).join(" ")}>
      <label htmlFor={inputId}>{label}</label>
      <div className={["place-field-control", pin ? "is-pinned" : null].filter(Boolean).join(" ")}>
        <span className="place-field-icon" aria-hidden="true" title={pin ? t("placeField.pinned") : undefined}>
          {pin ? <MapPin size={17} /> : <Search size={17} />}
        </span>
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={shown}
          aria-controls={listId}
          aria-activedescendant={shown && active >= 0 ? `${listId}-${active}` : undefined}
          value={value}
          placeholder={placeholder ?? t("placeField.placeholder")}
          maxLength={200}
          autoComplete="off"
          onChange={(event) => {
            onChange(event.target.value, null);
            const text = event.target.value.trim();
            if (text.length >= 2) setQuery(text);
            else close();
            // A finished "nothing found" belongs to the words it was found for.
            if (empty && empty.query !== text) setEmpty(null);
          }}
          onBlur={close}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              if (!shown) { setQuery(value.trim()); return; }
              setActive((index) => Math.min(options.length - 1, index + 1));
            } else if (event.key === "ArrowUp" && shown) {
              event.preventDefault();
              setActive((index) => Math.max(0, index - 1));
            } else if (event.key === "Enter" && shown && active >= 0) {
              // Picks the highlighted place instead of submitting the form.
              event.preventDefault();
              pick(options[active]);
            } else if (event.key === "Escape" && (shown || query !== null)) {
              // Closes the list, not the dialog around it.
              event.stopPropagation();
              close();
            }
          }}
        />
        {value && (
          <Button
            variant="icon"
            className="place-field-clear"
            aria-label={t("placeField.clear")}
            title={t("placeField.clear")}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => { onChange("", null); close(); inputRef.current?.focus(); }}
          >
            <X size={16} />
          </Button>
        )}
        <Button
          variant="icon"
          className="place-field-toggle"
          aria-label={t("placeField.showPlaces")}
          title={t("placeField.showPlaces")}
          aria-expanded={shown}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (shown) { close(); return; }
            inputRef.current?.focus();
            setQuery("");
          }}
        >
          <ChevronDown size={16} />
        </Button>
      </div>
      {open && !shown && empty && (empty.query === "" || empty.query === value.trim()) && (
        <p className="place-field-hint" role="status">
          {!empty.available
            ? t("placeField.unavailable")
            : empty.query
              ? t("placeField.noMatch", { text: empty.query })
              : t("placeField.noneYet")}
        </p>
      )}
      {shown && (
        <ul className="place-field-list" id={listId} role="listbox" aria-label={label}>
          {options.map((option, index) => (
            <li
              key={`${option.kind}:${option.label}`}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              className={index === active ? "is-active" : undefined}
              // mousedown, not click: the input's blur would close the list first.
              onMouseDown={(event) => { event.preventDefault(); pick(option); }}
              onMouseEnter={() => setActive(index)}
            >
              {option.kind === "known" ? <History size={16} aria-hidden="true" /> : <MapPin size={16} aria-hidden="true" />}
              <span>{option.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
