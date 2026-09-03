import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

// Multi-select chip input with type-ahead suggestions: chips and the box that
// adds them share one field, and the matches drop under it as you type, with
// "Add …" for a value nobody has used yet. Every place a set of names or tags
// is edited wears this — book authors, narrators and tags, a person's tags,
// a quote's, a story's — so they all behave the same way.
export function PeopleCombobox({
  value,
  onChange,
  suggestions,
  placeholder,
  disabled = false,
  autoFocus = false
}: {
  value: string[];
  onChange: (value: string[]) => void;
  suggestions: string[];
  placeholder?: string;
  /** Set while a save is in flight, where the field edits the thing directly
   *  rather than a form that is submitted later. */
  disabled?: boolean;
  /** For a field that appears on demand (a Tags button that swaps this in),
   *  so the person can type at once. The list stays shut until they do. */
  autoFocus?: boolean;
}) {
  const { t } = useTranslation(["common", "book"]);
  const [inputValue, setInputValue] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = suggestions.filter(
    (s) => !value.includes(s) && s.toLowerCase().includes(inputValue.toLowerCase())
  );

  const add = (name: string) => {
    const trimmed = name.trim();
    if (trimmed && !value.includes(trimmed)) {
      onChange([...value, trimmed]);
    }
    setInputValue("");
    // Close after a pick — otherwise the now-empty input matches every remaining
    // suggestion, so the floating list lingers over the form (and over the Save
    // button below it, intercepting the click). Re-typing or clicking the field
    // reopens it for adding more.
    setOpen(false);
  };

  const remove = (name: string) => {
    onChange(value.filter((v) => v !== name));
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && inputValue.trim()) {
      e.preventDefault();
      add(inputValue);
    } else if (e.key === "Backspace" && !inputValue && value.length > 0) {
      remove(value[value.length - 1]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Focusing fires onFocus, which opens the list; shut it again, because on an
  // empty box that list is every suggestion there is, hanging over whatever the
  // field appeared in front of. Typing or clicking the field brings it back.
  useEffect(() => {
    if (!autoFocus) return;
    inputRef.current?.focus();
    setOpen(false);
  }, [autoFocus]);

  const showNew = inputValue.trim() && !value.includes(inputValue.trim()) && !filtered.some((s) => s.toLowerCase() === inputValue.trim().toLowerCase());

  return (
    <div className="people-combobox" ref={containerRef}>
      <div
        className="people-combobox-input-area"
        onClick={() => { if (!disabled) { inputRef.current?.focus(); setOpen(true); } }}
      >
        {value.map((name) => (
          <span key={name} className="people-chip">
            {name}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); remove(name); }}
              disabled={disabled}
              aria-label={t("book:catalog.combobox.removeAria", { name })}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={inputValue}
          onChange={(e) => { setInputValue(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={value.length === 0 ? placeholder : ""}
          disabled={disabled}
        />
      </div>
      {open && !disabled && (filtered.length > 0 || showNew) && (
        <div className="people-combobox-dropdown">
          {filtered.map((s) => (
            <button key={s} type="button" className="people-combobox-option" onMouseDown={(e) => { e.preventDefault(); add(s); }}>
              {s}
            </button>
          ))}
          {showNew && (
            <button type="button" className="people-combobox-option people-combobox-option-new" onMouseDown={(e) => { e.preventDefault(); add(inputValue); }}>
              {t("book:catalog.combobox.addNew", { name: inputValue.trim() })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
