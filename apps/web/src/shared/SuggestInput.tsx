import { useEffect, useRef, useState } from "react";

// One value, typed or picked: a plain text field with the values already in use
// dropping under it as you type. The multi-value sibling is PeopleCombobox, and
// they share its dropdown's look — a book's series, a story's byline.
export function SuggestInput({
  value,
  onChange,
  onCommit,
  suggestions,
  placeholder,
  maxLength,
  ariaLabel
}: {
  value: string;
  onChange: (value: string) => void;
  /** For a field that saves on the way out rather than on a Save button. Takes
   *  the value rather than reading it back: picking a suggestion commits in the
   *  same tick it changes, before any state the caller keeps has caught up. */
  onCommit?: (value: string) => void;
  suggestions: string[];
  placeholder?: string;
  maxLength?: number;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = suggestions.filter(
    (suggestion) => suggestion.toLowerCase().includes(value.toLowerCase()) && suggestion !== value
  );

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div className="suggest-input" ref={containerRef}>
      <input
        value={value}
        aria-label={ariaLabel}
        maxLength={maxLength}
        onChange={(event) => { onChange(event.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => onCommit?.(value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" || event.key === "Enter") setOpen(false);
        }}
        placeholder={placeholder}
      />
      {open && filtered.length > 0 && (
        <div className="people-combobox-dropdown">
          {filtered.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="people-combobox-option"
              // mousedown, not click: the field's own blur would close the list
              // out from under the pointer first.
              onMouseDown={(event) => {
                event.preventDefault();
                onChange(suggestion);
                setOpen(false);
                onCommit?.(suggestion);
              }}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
