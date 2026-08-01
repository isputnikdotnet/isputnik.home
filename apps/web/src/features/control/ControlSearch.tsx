import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Search } from "lucide-react";
import { Modal } from "../../shared/Modal";
import { navigate } from "../../router";
import { CONTROL_SEARCH_ENTRIES, searchControlPanel, type ControlSearchEntry } from "./search-index";

// Everything in the control panel, one keystroke away. Opens on Ctrl/⌘+K or the
// button at the top of the nav; picking a result navigates to the tab that owns
// the setting. With an empty box it lists a few common destinations rather than
// nothing, so the palette is useful before you know what to type.
const EMPTY_STATE_IDS = ["tab:libraries", "tab:users", "tab:backup", "tab:email", "tab:securityPolicies", "tab:logs"];

const EMPTY_STATE = EMPTY_STATE_IDS
  .map((id) => CONTROL_SEARCH_ENTRIES.find((entry) => entry.id === id))
  .filter((entry): entry is ControlSearchEntry => Boolean(entry));

export function ControlSearch({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => (query.trim() ? searchControlPanel(query) : EMPTY_STATE), [query]);
  const active = results[highlight];

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // A new query always starts at the top result.
  useEffect(() => {
    setHighlight(0);
  }, [query]);

  // Keep the keyboard selection in view when arrowing past the fold.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".control-search-result.is-active")?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const go = (entry: ControlSearchEntry) => {
    onClose();
    navigate(entry.href);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((current) => (results.length ? (current + 1) % results.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((current) => (results.length ? (current - 1 + results.length) % results.length : 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (active) go(active);
    }
  };

  return (
    <Modal
      variant="card"
      className="control-search-modal"
      title="Search the control panel"
      icon={<Search size={20} />}
      onClose={onClose}
    >
      <div className="control-search-box">
        <Search size={18} aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          className="control-search-input"
          placeholder="Try “smtp”, “lockout”, “duplicate”…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded
          aria-controls="control-search-results"
          aria-activedescendant={active ? `control-search-${active.id}` : undefined}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div className="control-search-results" id="control-search-results" role="listbox" ref={listRef}>
        {!query.trim() && <p className="control-search-hint">Jump to a page or a setting</p>}
        {results.length === 0 ? (
          <p className="control-search-empty">
            Nothing matches “{query.trim()}”. Try the name of the setting, or a word from it.
          </p>
        ) : (
          results.map((entry, index) => (
            <button
              type="button"
              key={entry.id}
              id={`control-search-${entry.id}`}
              role="option"
              aria-selected={index === highlight}
              className={`control-search-result${index === highlight ? " is-active" : ""}`}
              onMouseMove={() => setHighlight(index)}
              onClick={() => go(entry)}
            >
              <span className="control-search-result-copy">
                <strong>{entry.title}</strong>
                <small>{entry.breadcrumb}</small>
              </span>
              {index === highlight && <CornerDownLeft size={16} aria-hidden="true" />}
            </button>
          ))
        )}
      </div>
    </Modal>
  );
}

// Ctrl/⌘+K anywhere in the control panel. Ignored while a text field has focus
// with a modifier-free key, but ⌘K is unambiguous so it works from the search
// boxes on Users, Logs and Libraries too.
export function useControlSearchShortcut(open: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        open();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
}
