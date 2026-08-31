import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";

// The one way to edit a set of tags: chips for what is chosen, one box to add
// more, a datalist of suggestions. Enter and comma commit the draft, Backspace
// on an empty box takes the last chip back — the usual chip-input reflexes.
//
// The draft also commits on blur, so `value` is always what the person sees;
// no caller has to remember that a half-typed word still counts.
export function TagInput({
  value,
  onChange,
  suggestions = [],
  placeholder,
  hint,
  disabled = false,
  autoFocus = false,
  listId = "tag-input-suggestions"
}: {
  value: string[];
  onChange: (next: string[]) => void;
  /** Existing tags to offer in the datalist; already-chosen ones are filtered out. */
  suggestions?: string[];
  placeholder?: string;
  /** Small line under the box explaining what happens on save. */
  hint?: React.ReactNode;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Unique when more than one TagInput can be on screen at once. */
  listId?: string;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");

  // A tag is "the same" when it differs only by case or padding. The server
  // normalizes further; this just stops the chip row showing a duplicate.
  const commit = (raw: string) => {
    const next = raw.trim();
    setDraft("");
    if (!next || value.some((tag) => tag.toLowerCase() === next.toLowerCase())) return;
    onChange([...value, next]);
  };

  const drop = (tag: string) => onChange(value.filter((item) => item !== tag));

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      // Enter must not reach a surrounding dialog's form and submit it.
      event.preventDefault();
      commit(draft);
    } else if (event.key === "Backspace" && draft === "" && value.length > 0) {
      drop(value[value.length - 1]);
    }
  };

  const unchosen = suggestions.filter(
    (tag) => !value.some((chosen) => chosen.toLowerCase() === tag.toLowerCase())
  );

  return (
    <div className="tag-input">
      {value.length > 0 && (
        <ul className="tag-input-chips">
          {value.map((tag) => (
            <li key={tag}>
              <span>{tag}</span>
              <button
                type="button"
                className="icon-button"
                onClick={() => drop(tag)}
                disabled={disabled}
                title={t("tagInput.remove", { tag })}
                aria-label={t("tagInput.remove", { tag })}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <label>
        <span className="sr-only">{t("tagInput.label")}</span>
        <input
          list={listId}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => commit(draft)}
          placeholder={placeholder ?? t("tagInput.placeholder")}
          maxLength={80}
          disabled={disabled}
          autoFocus={autoFocus}
        />
      </label>
      <datalist id={listId}>
        {unchosen.map((tag) => <option key={tag} value={tag} />)}
      </datalist>

      {hint && <span className="muted tag-input-hint">{hint}</span>}
    </div>
  );
}
