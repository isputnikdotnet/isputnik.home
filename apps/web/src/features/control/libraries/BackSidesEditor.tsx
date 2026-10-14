import { useState } from "react";
import { ChevronDown, ChevronUp, FlipHorizontal2, PenLine, ScanLine, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { MessageBox } from "../../../shared/MessageBox";
import type { BackSideSourceId, BackSidesSettings } from "../../audiobooks/types";

// Back sides of scanned prints (docs/back-sides-proposal.md): the per-library
// rule that pairs `X_b.jpg` with `X.jpg` by name. Same table as the scan sources
// above it — a checkbox and an order per source — plus the library's own
// patterns, and a dry run that counts what a rescan would pair before anything
// is saved. Off everywhere by default: turning it on moves photos out of the
// grid and into their fronts, which is a decision per library.

const PRESET_PATTERNS: Record<Exclude<BackSideSourceId, "custom">, string[]> = {
  epson: ["{name}_b"],
  named: ["{name}_back", "{name}-back", "{name}.back"]
};

const SOURCE_ICONS: Record<BackSideSourceId, LucideIcon> = {
  epson: ScanLine,
  named: FlipHorizontal2,
  custom: PenLine
};

export interface BackSidesCheck {
  files: number;
  pairs: number;
  itemsToRetire: number;
  unmatched: number;
}

/** `{name}` exactly once, something besides it, nothing a file name refuses. */
export function isValidBackPattern(value: string): boolean {
  const pattern = value.trim();
  if (pattern.length < 2 || pattern.length > 64 || pattern === "{name}") return false;
  if (pattern.split("{name}").length !== 2) return false;
  return !/[\\/:*?"<>|{}]/.test(pattern.replace("{name}", ""));
}

/** The patterns in force, in the order shown: what a hand-added back is named by. */
export function firstBackPattern(value: BackSidesSettings): string {
  for (const source of value.sources) {
    if (!source.enabled) continue;
    const list = source.id === "custom" ? value.patterns : PRESET_PATTERNS[source.id];
    if (list[0]) return list[0];
  }
  return "{name}_back";
}

export function BackSidesEditor({
  value,
  onChange,
  libraryId
}: {
  value: BackSidesSettings;
  onChange: (next: BackSidesSettings) => void;
  /** The library being edited; absent in the wizard, where there is nothing to check yet. */
  libraryId?: string;
}) {
  const { t } = useTranslation(["common", "control"]);
  const [draft, setDraft] = useState("");
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<BackSidesCheck | null>(null);
  const [checkError, setCheckError] = useState("");

  const reorder = (from: number, to: number) => {
    if (from === to || to < 0 || to >= value.sources.length) return;
    const sources = [...value.sources];
    const [item] = sources.splice(from, 1);
    sources.splice(to, 0, item);
    onChange({ ...value, sources });
  };

  const addPattern = () => {
    const pattern = draft.trim();
    if (!isValidBackPattern(pattern)) return;
    if (!value.patterns.some((existing) => existing.toLowerCase() === pattern.toLowerCase())) {
      onChange({ ...value, patterns: [...value.patterns, pattern] });
    }
    setDraft("");
  };

  const runCheck = async () => {
    if (!libraryId) return;
    setChecking(true);
    setCheckError("");
    try {
      const result = await api<BackSidesCheck>(`/api/library/gallery-libraries/${libraryId}/back-sides/check`, {
        method: "POST",
        body: JSON.stringify({ backSides: value })
      });
      setCheck(result);
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : t("control:libraries.backSides.unableToCheck"));
    } finally {
      setChecking(false);
    }
  };

  const labelOf = (id: BackSideSourceId) =>
    id === "epson" ? t("control:libraries.backSides.epsonLabel")
      : id === "named" ? t("control:libraries.backSides.namedLabel")
        : t("control:libraries.backSides.customLabel");

  return (
    <div className="field back-sides-editor">
      <span>{t("control:libraries.backSides.title")}</span>
      <p className="scan-sources-hint">{t("control:libraries.backSides.hint")}</p>
      <div className="scan-source-table">
        {value.sources.map((source, index) => {
          const Icon = SOURCE_ICONS[source.id];
          const label = labelOf(source.id);
          return (
            <div key={source.id} className={`scan-source-row${source.enabled ? "" : " disabled"}`}>
              <input
                type="checkbox"
                className="scan-source-check"
                checked={source.enabled}
                onChange={(event) =>
                  onChange({ ...value, sources: value.sources.map((item, i) => (i === index ? { ...item, enabled: event.target.checked } : item)) })}
                aria-label={t("control:libraries.enableSourceAria", { label })}
              />
              <span className="scan-source-icon" aria-hidden="true"><Icon size={20} /></span>
              <span className="scan-source-copy">
                <span className="scan-source-title-row">
                  <strong>{label}</strong>
                  {source.id !== "custom" && <span className="scan-source-badge">{t("control:libraries.backSides.preset")}</span>}
                </span>
                <small>
                  {source.id === "epson" && <Trans t={t} i18nKey="control:libraries.backSides.epsonDesc" components={{ code: <code /> }} />}
                  {source.id === "named" && <Trans t={t} i18nKey="control:libraries.backSides.namedDesc" components={{ code: <code /> }} />}
                  {source.id === "custom" && <Trans t={t} i18nKey="control:libraries.backSides.customDesc" components={{ code: <code /> }} />}
                </small>
                {source.id === "custom" && (
                  <span className="back-sides-patterns">
                    <span className="extension-chips">
                      {value.patterns.map((pattern) => (
                        <span className="extension-chip" key={pattern}>
                          <code>{pattern}</code>
                          <Button
                            variant="bare"
                            aria-label={t("control:libraries.backSides.removePatternAria", { pattern })}
                            onClick={() => onChange({ ...value, patterns: value.patterns.filter((item) => item !== pattern) })}
                          >
                            <X size={12} />
                          </Button>
                        </span>
                      ))}
                      {value.patterns.length === 0 && <span className="muted">{t("control:libraries.backSides.noPatterns")}</span>}
                    </span>
                    <span className="extension-add-row">
                      <input
                        type="text"
                        value={draft}
                        placeholder={t("control:libraries.backSides.patternPlaceholder")}
                        maxLength={64}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            addPattern();
                          }
                        }}
                      />
                      <Button variant="secondary" compact onClick={addPattern} disabled={!isValidBackPattern(draft)}>
                        {t("control:ui.add")}
                      </Button>
                    </span>
                  </span>
                )}
              </span>
              <span className="scan-source-actions">
                <Button
                  variant="icon"
                  compact
                  type="button"
                  className="scan-source-move"
                  disabled={index === 0}
                  aria-label={t("control:libraries.moveUpAria", { label })}
                  title={t("control:libraries.moveUp")}
                  onClick={() => reorder(index, index - 1)}
                >
                  <ChevronUp size={16} />
                </Button>
                <Button
                  variant="icon"
                  compact
                  type="button"
                  className="scan-source-move"
                  disabled={index === value.sources.length - 1}
                  aria-label={t("control:libraries.moveDownAria", { label })}
                  title={t("control:libraries.moveDown")}
                  onClick={() => reorder(index, index + 1)}
                >
                  <ChevronDown size={16} />
                </Button>
              </span>
            </div>
          );
        })}
      </div>
      <p className="scan-sources-hint">
        <Trans
          t={t}
          i18nKey="control:libraries.backSides.keepNote"
          values={{ pattern: firstBackPattern(value) }}
          components={{ code: <code /> }}
        />
      </p>
      {libraryId && (
        <div className="back-sides-check">
          <Button variant="secondary" compact type="button" onClick={() => void runCheck()} disabled={checking}>
            {checking ? t("control:libraries.backSides.checking") : t("control:libraries.backSides.check")}
          </Button>
          <span className="muted">
            {check ? t("control:libraries.backSides.checkedFiles", { count: check.files }) : t("control:libraries.backSides.checkHint")}
          </span>
        </div>
      )}
      {checkError && (
        <MessageBox tone="error" title={t("control:libraries.backSides.unableToCheck")}>{checkError}</MessageBox>
      )}
      {check && !checkError && (
        <MessageBox tone="info" title={t("control:libraries.backSides.checkTitle", { count: check.pairs })}>
          <ul className="back-sides-check-list">
            <li>{t("control:libraries.backSides.checkMatched", { count: check.pairs })}</li>
            <li>{t("control:libraries.backSides.checkRetire", { count: check.itemsToRetire })}</li>
            <li>{t("control:libraries.backSides.checkUnmatched", { count: check.unmatched })}</li>
          </ul>
        </MessageBox>
      )}
    </div>
  );
}
