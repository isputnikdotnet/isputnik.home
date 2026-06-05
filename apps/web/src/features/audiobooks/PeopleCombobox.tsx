import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";

// Multi-select chip input with type-ahead suggestions. Used for authors,
// narrators, and tags in both the book-detail edit form and the bulk-edit form,
// so each field can pick existing values or add a new one.
export function PeopleCombobox({
  value,
  onChange,
  suggestions,
  placeholder
}: {
  value: string[];
  onChange: (value: string[]) => void;
  suggestions: string[];
  placeholder?: string;
}) {
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

  const showNew = inputValue.trim() && !value.includes(inputValue.trim()) && !filtered.some((s) => s.toLowerCase() === inputValue.trim().toLowerCase());

  return (
    <div className="people-combobox" ref={containerRef}>
      <div className="people-combobox-input-area" onClick={() => inputRef.current?.focus()}>
        {value.map((name) => (
          <span key={name} className="people-chip">
            {name}
            <button type="button" onClick={(e) => { e.stopPropagation(); remove(name); }} aria-label={`Remove ${name}`}>
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
        />
      </div>
      {open && (filtered.length > 0 || showNew) && (
        <div className="people-combobox-dropdown">
          {filtered.map((s) => (
            <button key={s} type="button" className="people-combobox-option" onMouseDown={(e) => { e.preventDefault(); add(s); }}>
              {s}
            </button>
          ))}
          {showNew && (
            <button type="button" className="people-combobox-option people-combobox-option-new" onMouseDown={(e) => { e.preventDefault(); add(inputValue); }}>
              Add "{inputValue.trim()}"
            </button>
          )}
        </div>
      )}
    </div>
  );
}
