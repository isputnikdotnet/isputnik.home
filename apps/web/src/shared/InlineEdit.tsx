import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pencil } from "lucide-react";

// Text that turns into its own field where it sits. The editor pages show a
// story the way a reader sees it — a heading is a heading, not a labelled box
// in a form — so the affordance is a pencil beside the words rather than a
// field around them.
//
// It saves the way the rest of the story editor saves: on blur, and on Enter
// (Ctrl/Cmd+Enter for prose). Escape puts the original text back. There is no
// Save button anywhere in this editor, so nothing is lost by clicking away.
export function InlineEdit({
  value,
  onSave,
  ariaLabel,
  placeholder,
  multiline = false,
  rows = 3,
  maxLength,
  className,
  display,
  disabled = false
}: {
  value: string;
  /** Called only when the text actually changed. */
  onSave: (next: string) => void;
  /** Names the field for the pencil button and the input. */
  ariaLabel: string;
  /** Shown, muted, when there is nothing written yet. */
  placeholder?: string;
  multiline?: boolean;
  rows?: number;
  maxLength?: number;
  className?: string;
  /** Richer idle rendering (markdown prose, say). Falls back to the raw text. */
  display?: ReactNode;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const fieldRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  // A sibling edit re-reads the whole story; adopt the server's text, but never
  // over the top of what is being typed here.
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);

  useEffect(() => {
    if (!editing) return;
    const field = fieldRef.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next !== value.trim()) onSave(next);
  };

  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };

  if (editing) {
    const shared = {
      ref: fieldRef as never,
      className: "inline-edit-field",
      value: draft,
      maxLength,
      "aria-label": ariaLabel,
      placeholder,
      onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
      onBlur: commit,
      onKeyDown: (event: React.KeyboardEvent) => {
        if (event.key === "Escape") { event.preventDefault(); cancel(); }
        if (event.key === "Enter" && (!multiline || event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          commit();
        }
      }
    };
    return (
      <span className={`inline-edit is-editing${className ? ` ${className}` : ""}`}>
        {multiline ? <textarea {...shared} rows={rows} /> : <input {...shared} type="text" />}
      </span>
    );
  }

  const empty = value.trim().length === 0;
  return (
    <span className={`inline-edit${className ? ` ${className}` : ""}`}>
      <span className={`inline-edit-value${empty ? " is-empty" : ""}`}>
        {empty ? placeholder : display ?? value}
      </span>
      {!disabled && (
        <button
          type="button"
          className="inline-edit-pencil"
          onClick={() => setEditing(true)}
          aria-label={ariaLabel}
          title={ariaLabel}
        >
          <Pencil size={14} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
