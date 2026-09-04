import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { humanize } from "./layout-model";
import { rulesBase, type LayoutLibrary, type PreviewRow, type ScanRule } from "./types";
import { useRoleLabels } from "./useRoleLabels";

// Step 3: what a scan of the chosen folders will produce, read from the same
// matcher a scan uses. Four figures carry the decision; notices appear only for
// what needs deciding before saving; the table shows every book with the fields
// its layout captured and what saving does to the book catalogued there today.
type Filter = "all" | "unmatched" | "warnings" | "changing" | `l${number}`;

export function PreviewStep({
  library,
  folders,
  layouts,
  ruleId,
  rows,
  onRows,
  existingRules
}: {
  library: LayoutLibrary;
  folders: string[];
  layouts: string[];
  ruleId: string | null;
  rows: PreviewRow[] | null;
  onRows: (rows: PreviewRow[] | null) => void;
  existingRules: ScanRule[];
}) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const roleLabels = useRoleLabels();
  const kind = library.type;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    onRows(null);
    (async () => {
      try {
        const payload = await api<{ rows: PreviewRow[] }>(`${rulesBase(library.id)}/preview`, {
          method: "POST", body: JSON.stringify({ paths: folders, layouts, ruleId })
        });
        if (!cancelled) { onRows(payload.rows); setError(""); }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : t("controlAdmin:layout.previewFailed"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [library.id, folders.join("\n"), layouts.join(" "), ruleId]); // eslint-disable-line react-hooks/exhaustive-deps

  const all = rows ?? [];
  const matched = all.filter((r) => r.matched);
  const unmatched = all.filter((r) => !r.matched);
  const warned = all.filter((r) => r.warnings.length > 0);
  const changing = all.filter((r) => r.change.startsWith("merges:"));
  // Duplicate (series, position) pairs, derived from the rows rather than parsed
  // out of the server's warning text.
  const duplicates = useMemo(() => {
    const groups = new Map<string, { series: string; position: number; n: number }>();
    for (const row of matched) {
      if (!row.series || row.position === undefined) continue;
      const key = `${row.series.toLowerCase()}#${row.position}`;
      const g = groups.get(key) ?? { series: row.series, position: row.position, n: 0 };
      g.n += 1;
      groups.set(key, g);
    }
    return [...groups.values()].filter((g) => g.n > 1);
  }, [matched]);

  const visible = all.filter((r) => {
    if (filter === "unmatched") return !r.matched;
    if (filter === "warnings") return r.warnings.length > 0;
    if (filter === "changing") return r.change.startsWith("merges:");
    if (filter.startsWith("l")) return r.layoutIndex === Number(filter.slice(1));
    return true;
  }).filter((r) => !query || `${r.path} ${r.title ?? ""}`.toLowerCase().includes(query.toLowerCase()));

  const ruleName = (id: string) => existingRules.find((r) => r.id === id)?.name ?? id;
  const changeLabel = (row: PreviewRow) => {
    const c = row.change;
    if (c === "new") return t("controlAdmin:layout.changeNew");
    if (c === "unchanged") return t("controlAdmin:layout.changeUnchanged");
    if (c === "moves-from-default") return t("controlAdmin:layout.changeFromDefault");
    if (c === "added-without-fields") return t("controlAdmin:layout.changeAddedWithoutFields");
    if (c.startsWith("moves-from-rule:")) return t("controlAdmin:layout.changeFromRule", { name: ruleName(c.slice("moves-from-rule:".length)) });
    if (c.startsWith("merges:")) return t("controlAdmin:layout.changeMerges", { count: Number(c.slice("merges:".length)) });
    return c;
  };

  const val = (cls: string, v: string | number | undefined, fallback: "file" | "dash" = "file") =>
    v === undefined || v === "" ? <span className="layout-from-file">{fallback === "file" ? t("controlAdmin:layout.fromFile") : "—"}</span> : <span className={`layout-val is-${cls}`}>{v}</span>;

  const tile = (id: Filter, n: number, label: string, tone: "ok" | "warn" | "none") => (
    <button type="button" className={`layout-tile is-${tone}`} aria-pressed={filter === id} onClick={() => setFilter(filter === id ? "all" : id)}>
      <span className="layout-tile-n">{n}</span>
      <span className="layout-tile-t">{label}</span>
    </button>
  );

  return (
    <div className="layout-preview">
      {error && <MessageBox tone="error" title={t("controlAdmin:layout.errorTitle")}>{error}</MessageBox>}
      {loading && <p className="muted">{t("controlAdmin:layout.previewLoading")}</p>}
      {rows && (
        <>
          <div className="layout-tiles">
            {tile("all", matched.length, t("controlAdmin:layout.tileRecognized"), "ok")}
            {tile("unmatched", unmatched.length, t("controlAdmin:layout.tileUnmatched"), unmatched.length ? "warn" : "none")}
            {tile("warnings", warned.length, t("controlAdmin:layout.tileWarnings"), warned.length ? "warn" : "none")}
            {tile("changing", changing.length, t("controlAdmin:layout.tileChanging"), changing.length ? "warn" : "none")}
          </div>

          {changing.length > 0 && (
            <MessageBox tone="warning" title={t("controlAdmin:layout.noteRebuildTitle", { count: changing.length })}>
              {t("controlAdmin:layout.noteRebuild")}
            </MessageBox>
          )}
          {duplicates.length > 0 && (
            <MessageBox tone="warning" title={t("controlAdmin:layout.noteDuplicatesTitle")}>
              {t("controlAdmin:layout.noteDuplicates")}
              <ul className="layout-note-list">{duplicates.map((d) => <li key={`${d.series}#${d.position}`}>{t("controlAdmin:layout.duplicateLine", { count: d.n, series: d.series, position: d.position })}</li>)}</ul>
            </MessageBox>
          )}
          <MessageBox tone="info" title={t("controlAdmin:layout.noteSavingTitle")}>{t("controlAdmin:layout.noteSaving")}</MessageBox>

          <div className="layout-filters">
            <button type="button" className="layout-filter" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>{t("controlAdmin:layout.filterAll")} <span>{all.length}</span></button>
            {layouts.map((layout, i) => (
              <button key={i} type="button" className="layout-filter" aria-pressed={filter === `l${i}`} onClick={() => setFilter(`l${i}`)}>
                {t("controlAdmin:layout.layoutN", { n: i + 1 })} · {humanize(layout, roleLabels)} <span>{matched.filter((r) => r.layoutIndex === i).length}</span>
              </button>
            ))}
            <button type="button" className="layout-filter" aria-pressed={filter === "unmatched"} onClick={() => setFilter("unmatched")}>{t("controlAdmin:layout.filterNoLayout")} <span>{unmatched.length}</span></button>
            <button type="button" className="layout-filter" aria-pressed={filter === "warnings"} onClick={() => setFilter("warnings")}>{t("controlAdmin:layout.filterWarnings")} <span>{warned.length}</span></button>
            <span className="layout-spacer" />
            <input className="layout-search" type="search" value={query} placeholder={t("controlAdmin:layout.filterPlaceholder")} aria-label={t("controlAdmin:layout.filterPlaceholder")} onChange={(event) => setQuery(event.target.value)} />
          </div>

          {all.length === 0 ? (
            <div className="layout-empty">{t("controlAdmin:layout.previewEmpty")}</div>
          ) : (
            <div className="layout-table-wrap">
              <table className="layout-table">
                <thead>
                  <tr>
                    <th>{kind === "audiobook" ? t("controlAdmin:layout.thBookFolder") : t("controlAdmin:layout.thFromFile")}</th>
                    <th>{t("controlAdmin:layout.thLayout")}</th>
                    <th><span className="layout-sw is-author" aria-hidden="true" />{t("controlAdmin:layout.roleAuthor")}</th>
                    <th><span className="layout-sw is-series" aria-hidden="true" />{t("controlAdmin:layout.roleSeries")}</th>
                    <th className="is-num">#</th>
                    <th><span className="layout-sw is-title" aria-hidden="true" />{t("controlAdmin:layout.roleTitle")}</th>
                    {kind === "audiobook" && <th><span className="layout-sw is-narrator" aria-hidden="true" />{t("controlAdmin:layout.roleNarrator")}</th>}
                    <th className="is-num">{kind === "audiobook" ? t("controlAdmin:layout.thTracks") : t("controlAdmin:layout.thFormats")}</th>
                    <th>{t("controlAdmin:layout.thChange")}</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.length === 0 && (
                    <tr><td colSpan={9} className="layout-table-empty">{t("controlAdmin:layout.nothingMatches")}</td></tr>
                  )}
                  {visible.map((row) => {
                    const segs = row.path.split("/");
                    const leaf = segs.pop();
                    return (
                      <tr key={row.path} className={`${row.warnings.length ? "is-warn" : ""} ${row.matched ? "" : "is-none"}`}>
                        <td className="layout-td-path">
                          <span className="layout-td-dir">{segs.length ? `${segs.join("/")}/` : ""}</span>{leaf}
                          {row.warnings.map((w) => <span key={w} className="layout-td-note">{w}</span>)}
                        </td>
                        <td>{row.layoutIndex === null ? <span className="layout-lay is-none">{t("controlAdmin:layout.none")}</span> : <span className="layout-lay">{t("controlAdmin:layout.layoutN", { n: row.layoutIndex + 1 })}</span>}</td>
                        <td>{row.matched ? val("author", row.author) : ""}</td>
                        <td>{row.matched ? val("series", row.series, "dash") : ""}</td>
                        <td className="is-num">{row.matched ? val("position", row.position, "dash") : ""}</td>
                        <td>{row.matched ? val("title", row.title) : <span className="layout-from-file">{t("controlAdmin:layout.fromFile")}</span>}</td>
                        {kind === "audiobook" && <td>{row.matched ? val("narrator", row.narrator) : ""}</td>}
                        <td className="is-num">{kind === "audiobook" ? row.tracks ?? "" : (row.formats ?? []).map((f) => <code key={f}>.{f}</code>)}</td>
                        <td><span className={`layout-change ${row.change.startsWith("merges:") ? "is-hot" : ""}`}>{changeLabel(row)}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="layout-summary muted">
            {t("controlAdmin:layout.matchesSummary", { matched: matched.length, total: all.length })}
            {warned.length > 0 && ` · ${t("controlAdmin:layout.warningsCount", { count: warned.length })}`}
          </div>
        </>
      )}
    </div>
  );
}
