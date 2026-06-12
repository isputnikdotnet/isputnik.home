import { useState } from "react";
import { X } from "lucide-react";

// Editable file-extension list — used for the scan/upload formats and for the
// upload-only companion files.
export function ExtensionsEditor({
  extensions,
  onChange,
  defaults,
  label = "File extensions (scanning & upload)",
  emptyHint = "No extensions — nothing will be scanned."
}: {
  extensions: string[];
  onChange: (extensions: string[]) => void;
  defaults: string[];
  label?: string;
  emptyHint?: string;
}) {
  const [draft, setDraft] = useState("");

  const addDraft = () => {
    const value = draft.trim().toLowerCase().replace(/^\./, "");
    if (!/^[a-z0-9]{1,10}$/.test(value)) return;
    if (!extensions.includes(value)) {
      onChange([...extensions, value]);
    }
    setDraft("");
  };

  return (
    <div className="field">
      <span>{label}</span>
      <div className="extension-chips">
        {extensions.map((extension) => (
          <span className="extension-chip" key={extension}>
            .{extension}
            <button
              type="button"
              aria-label={`Remove .${extension}`}
              onClick={() => onChange(extensions.filter((item) => item !== extension))}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        {extensions.length === 0 && <span className="muted">{emptyHint}</span>}
      </div>
      <div className="extension-add-row">
        <input
          type="text"
          value={draft}
          placeholder="Add extension (e.g. wma)"
          maxLength={11}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addDraft();
            }
          }}
        />
        <button className="secondary-button compact-button" type="button" onClick={addDraft} disabled={!draft.trim()}>
          Add
        </button>
        <button
          className="secondary-button compact-button"
          type="button"
          onClick={() => onChange([...defaults])}
          title="Restore the default extensions for this library type"
        >
          Reset to defaults
        </button>
      </div>
    </div>
  );
}
