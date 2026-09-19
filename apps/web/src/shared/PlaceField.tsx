import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Globe, History, MapPin, Search, X } from "lucide-react";
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
//
// A caller that passes `searchOnline` gets one more line under that: a button
// that asks the internet for the same words. It is a button and not more
// typeahead on purpose — OpenStreetMap's policy forbids search-as-you-type, and
// pressing it is the moment her words leave the house. Review mode's "Where?"
// offers the same thing in the same shape.

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
  /** What the list shows: a found place's full address names which one it is. */
  label: string;
  /** What goes in the field when picked, when that is shorter than the label. */
  insert?: string;
  pin: PlacePin | null;
  /** "known" = already used nearby (drawn with a history mark), "town" = found
   *  in the places database, "online" = found by the online lookup. */
  kind: "known" | "town" | "online";
}

const SUGGEST_DELAY_MS = 250;
/** Below this, the words are too thin to send anywhere. */
const ONLINE_MIN_CHARS = 3;

export function PlaceField({
  label,
  value,
  pin,
  onChange,
  load,
  searchOnline,
  placeholder,
  className
}: {
  label: string;
  value: string;
  pin: PlacePin | null;
  onChange: (value: string, pin: PlacePin | null) => void;
  load: (query: string) => Promise<PlaceLoadResult>;
  /** Offered as a button when the list has nothing she meant. Left out, the
   *  field searches the places database alone. */
  searchOnline?: (query: string) => Promise<PlaceOption[]>;
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
  // The online lookup, and which words it was pressed for.
  const [online, setOnline] = useState<{ query: string; state: "busy" | "done" | "error" } | null>(null);
  const [active, setActive] = useState(-1);
  const request = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

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
    setOnline(null);
  };

  const pick = (option: PlaceOption) => {
    onChange(option.insert ?? option.label, option.pin);
    close();
  };

  /** One press, one request. The answer replaces the list under the box. */
  const runOnline = async (text: string) => {
    if (!searchOnline) return;
    const id = ++request.current;
    setOnline({ query: text, state: "busy" });
    try {
      const found = await searchOnline(text);
      if (request.current !== id) return;
      setOptions(found);
      setEmpty(null);
      setActive(-1);
      setOnline({ query: text, state: "done" });
    } catch {
      if (request.current === id) setOnline({ query: text, state: "error" });
    }
  };

  const typed = value.trim();
  const shown = open && options.length > 0;
  // The online offer belongs to the words in the box, so a picked place or a
  // stale query never carries it.
  const canOnline = Boolean(searchOnline) && open && query !== null && query === typed && typed.length >= ONLINE_MIN_CHARS;
  const answered = online?.query === typed ? online : null;
  const offerOnline = canOnline && answered?.state !== "done";
  const onlineNone = Boolean(answered && answered.state === "done" && options.length === 0);
  const onlineError = answered?.state === "error";
  // The place list's own "nothing found" — replaced once the online lookup has
  // spoken for the same words, which is the newer answer.
  const emptyShown = Boolean(
    open && !shown && empty && !onlineNone && !onlineError && (empty.query === "" || empty.query === typed)
  );
  const panel = shown || emptyShown || offerOnline || onlineNone || onlineError;

  return (
    <div ref={rootRef} className={["field", "place-field", className].filter(Boolean).join(" ")}>
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
            if (online && online.query !== text) setOnline(null);
          }}
          // Tabbing to the online button is leaving the input, not the field.
          onBlur={(event) => {
            if (event.relatedTarget && rootRef.current?.contains(event.relatedTarget)) return;
            close();
          }}
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
            } else if (event.key === "Escape" && (panel || query !== null)) {
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
      {panel && (
        <div className="place-field-panel">
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
                  {option.kind === "known"
                    ? <History size={16} aria-hidden="true" />
                    : option.kind === "online"
                      ? <Globe size={16} aria-hidden="true" />
                      : <MapPin size={16} aria-hidden="true" />}
                  <span>{option.label}</span>
                </li>
              ))}
            </ul>
          )}
          {(emptyShown || onlineNone || onlineError) && (
            <p className="place-field-hint" role="status">
              {onlineError
                ? t("placeField.onlineError")
                : onlineNone
                  ? t("placeField.onlineNone", { text: typed })
                  : !empty?.available
                    ? t("placeField.unavailable")
                    : empty?.query
                      ? t("placeField.noMatch", { text: empty.query })
                      : t("placeField.noneYet")}
            </p>
          )}
          {offerOnline && (
            <Button
              variant="text"
              className="place-field-online"
              title={t("placeField.onlineTitle")}
              disabled={answered?.state === "busy"}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void runOnline(typed)}
            >
              <Globe size={16} aria-hidden="true" />
              <span>{answered?.state === "busy" ? t("placeField.onlineBusy") : t("placeField.online", { text: typed })}</span>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
