import { useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { CornerDownLeft, Search } from "lucide-react";
import { followRoute, navigate } from "../../router";
import { cx } from "../../shared/cx";
import { visibleGuides } from "./catalog";
import { useGuideIndex } from "./guideSource";
import { searchGuides } from "./search";

// The search box at the top of the Help page. Results are guide SECTIONS, and
// picking one opens the guide scrolled to that heading. The guides are only
// fetched once someone focuses the box, and only the ones this person can open —
// a member searching never turns up a setup guide for a panel they can't reach.
export function HelpSearch({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [wanted, setWanted] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const guides = useMemo(() => visibleGuides(isAdmin), [isAdmin]);
  const titles = useMemo(() => new Map(guides.map((guide) => [guide.slug, guide.title])), [guides]);
  const slugs = useMemo(() => guides.map((guide) => guide.slug), [guides]);
  const index = useGuideIndex(slugs, wanted);
  const results = useMemo(
    () => (index.status === "ready" ? searchGuides(index.sections, query) : []),
    [index, query]
  );

  const trimmed = query.trim();
  const showPanel = open && trimmed.length > 0;
  const active = results[highlight];

  // "/" jumps to the box from anywhere on the page, as it does on most sites with
  // a search — unless the key is being typed into something.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // A new query always starts at the top result.
  useEffect(() => {
    setHighlight(0);
  }, [query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".help-search-result.is-active")?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && results.length) {
      event.preventDefault();
      setOpen(true);
      setHighlight((current) => (current + 1) % results.length);
    } else if (event.key === "ArrowUp" && results.length) {
      event.preventDefault();
      setHighlight((current) => (current - 1 + results.length) % results.length);
    } else if (event.key === "Enter" && showPanel && active) {
      event.preventDefault();
      navigate(active.href);
    } else if (event.key === "Escape") {
      if (query) setQuery("");
      else inputRef.current?.blur();
    }
  };

  return (
    <div
      className="help-search"
      onBlur={(event) => {
        // Stay open while focus moves onto a result (a click on one lands there first).
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <label className={cx("help-search-box", showPanel && "is-open")}>
        <Search size={20} aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          value={query}
          placeholder={t("help.searchPlaceholder")}
          aria-label={t("help.searchLabel")}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showPanel && results.length > 0}
          aria-controls="help-search-results"
          aria-activedescendant={showPanel && active ? `help-search-result-${highlight}` : undefined}
          autoComplete="off"
          spellCheck={false}
          onFocus={() => {
            setOpen(true);
            setWanted(true);
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setWanted(true);
          }}
          onKeyDown={onKeyDown}
        />
        {!query && (
          <span className="help-search-shortcut" aria-hidden="true">
            <Trans i18nKey="help.searchShortcut" components={{ kbd: <kbd /> }} />
          </span>
        )}
      </label>

      {showPanel && (
        <div className="help-search-panel">
          {(index.status === "idle" || index.status === "loading") && (
            <p className="help-search-status">{t("help.searchLoading")}</p>
          )}
          {index.status === "error" && <p className="help-search-status">{t("help.searchUnavailable")}</p>}
          {index.status === "ready" && results.length === 0 && (
            <p className="help-search-status">{t("help.searchNoResults", { query: trimmed })}</p>
          )}
          {results.length > 0 && (
            <>
              <div className="help-search-results" id="help-search-results" role="listbox" aria-label={t("help.searchLabel")} ref={listRef}>
                {results.map((result, position) => {
                  const guideTitle = titles.get(result.section.slug) ?? result.section.guideTitle;
                  return (
                    <a
                      key={`${result.href}-${position}`}
                      id={`help-search-result-${position}`}
                      role="option"
                      aria-selected={position === highlight}
                      tabIndex={-1}
                      className={cx("help-search-result", position === highlight && "is-active")}
                      href={result.href}
                      onClick={(event) => followRoute(event, result.href)}
                      onMouseMove={() => setHighlight(position)}
                    >
                      <span className="help-search-result-copy">
                        <small>{guideTitle}</small>
                        <strong>{result.section.heading ? result.title : guideTitle}</strong>
                        {result.snippet.length > 0 && (
                          <span className="help-search-snippet">
                            {result.snippet.map((part, partIndex) =>
                              part.hit ? <mark key={partIndex}>{part.text}</mark> : <span key={partIndex}>{part.text}</span>
                            )}
                          </span>
                        )}
                      </span>
                      {position === highlight && <CornerDownLeft size={16} aria-hidden="true" />}
                    </a>
                  );
                })}
              </div>
              <p className="help-search-footer">
                <span>{t("help.searchResultCount", { count: results.length })}</span>
                <span className="help-search-keys">{t("help.searchKeys")}</span>
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
