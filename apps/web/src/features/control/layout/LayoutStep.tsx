import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X, ChevronLeft, ChevronRight, AlertTriangle, Info, Check, Music } from "lucide-react";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { MessageBox } from "../../../shared/MessageBox";
import {
  PRESETS, applyPreset, draftFromExample, exampleDepth, extensionOf, groupsOf, guessRoles, humanize, joinAt, labelledSegments,
  nextDraftId, patternDepth, patternOf, problemsOf, rolesFor, splitGroup, textDraft,
  type LayoutDraft, type LayoutExample, type Role
} from "./layout-model";
import { rulesBase, type LayoutLibrary, type PreviewRow } from "./types";
import { useRoleLabels } from "./useRoleLabels";

// Step 2: how books are arranged. Presets fill a layout; the builder labels a real
// example path piece by piece; layouts stack as fallbacks; a debounced dry run
// keeps the match counts and the unmatched list live.
interface LiveCounts { byLayout: number[]; unmatched: PreviewRow[]; total: number }

export function LayoutStep({
  library,
  folders,
  ruleId,
  isDefault,
  name,
  nameEdited,
  onName,
  drafts,
  onDrafts
}: {
  library: LayoutLibrary;
  folders: string[];
  ruleId: string | null;
  isDefault: boolean;
  name: string;
  nameEdited: boolean;
  onName: (value: string) => void;
  drafts: LayoutDraft[];
  onDrafts: (drafts: LayoutDraft[]) => void;
}) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const roleLabels = useRoleLabels();
  const kind = library.type;
  const noun = kind === "audiobook" ? "audiobooks" : "books";
  const base = rulesBase(library.id);

  const [examples, setExamples] = useState<LayoutExample[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState("");
  const [counts, setCounts] = useState<LiveCounts | null>(null);
  const [counting, setCounting] = useState(false);
  const countRequest = useRef(0);

  const layouts = useMemo(() => drafts.map(patternOf), [drafts]);
  const valid = useMemo(() => drafts.map((d) => problemsOf(d, kind).every((p) => p.kind !== "error")), [drafts, kind]);

  // Representative paths under the chosen folders.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const payload = await api<{ examples: LayoutExample[] }>(`${base}/examples?paths=${encodeURIComponent(folders.join("\n"))}`);
        if (cancelled) return;
        setExamples(payload.examples);
        // A brand-new rule starts with one layout guessed from the first example.
        if (drafts.length === 0 && payload.examples.length > 0) onDrafts([draftFromExample(payload.examples[0], kind)]);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : t("controlAdmin:layout.examplesFailed"));
      }
    })();
    return () => { cancelled = true; };
    // The folders are what the examples come from; drafts are only read to decide
    // whether to guess a first layout, and following them would re-guess it away.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, folders.join("\n")]);

  // Live counts: a dry run over the valid layouts, debounced.
  useEffect(() => {
    const usable = layouts.map((l, i) => (valid[i] && l ? l : null));
    const sent = usable.filter((l): l is string => l !== null);
    if (sent.length === 0) { setCounts(null); return; }
    const requestId = (countRequest.current += 1);
    setCounting(true);
    const timer = setTimeout(async () => {
      try {
        const payload = await api<{ rows: PreviewRow[] }>(`${base}/preview`, {
          method: "POST", body: JSON.stringify({ paths: folders, layouts: sent, ruleId })
        });
        if (requestId !== countRequest.current) return;
        // Map indexes of the sent (valid-only) list back to draft positions.
        const positions = usable.map((l, i) => (l !== null ? i : -1)).filter((i) => i >= 0);
        const byLayout = drafts.map(() => 0);
        const unmatched: PreviewRow[] = [];
        for (const row of payload.rows) {
          if (row.layoutIndex === null) unmatched.push(row);
          else byLayout[positions[row.layoutIndex]] += 1;
        }
        setCounts({ byLayout, unmatched, total: payload.rows.length });
        setError("");
      } catch (err) {
        if (requestId === countRequest.current) setError(err instanceof Error ? err.message : t("controlAdmin:layout.previewFailed"));
      } finally {
        if (requestId === countRequest.current) setCounting(false);
      }
    }, 450);
    return () => clearTimeout(timer);
    // Keyed on the joined patterns rather than the arrays holding them: the dry
    // run is a request per change, and the arrays are new on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layouts.join("\u0000"), valid.join(","), folders.join("\n"), ruleId]);

  const update = (index: number, mutate: (draft: LayoutDraft) => void) => {
    const next = drafts.map((d, i) => {
      if (i !== index) return d;
      const copy: LayoutDraft = { ...d, segments: d.segments.map((s) => ({ tokens: s.tokens, joins: [...s.joins], roles: { ...s.roles } })) };
      mutate(copy);
      return copy;
    });
    onDrafts(next);
  };
  const replace = (index: number, draft: LayoutDraft) => onDrafts(drafts.map((d, i) => (i === index ? draft : d)));

  const pickPreset = (pattern: string) => {
    const depth = patternDepth(pattern);
    const target = drafts[selected];
    const fitting = (examples ?? []).find((e) => exampleDepth(e, kind) === depth) ?? target?.example ?? examples?.[0] ?? null;
    if (!fitting) return;
    const draft = target && target.mode === "builder" && target.example?.path === fitting.path
      ? { ...target, segments: target.segments.map((s) => ({ tokens: s.tokens, joins: [...s.joins], roles: { ...s.roles } })) }
      : { ...draftFromExample(fitting, kind), id: target?.id ?? nextDraftId() };
    applyPreset(draft, pattern, kind);
    if (drafts.length === 0) onDrafts([draft]); else replace(selected, draft);
  };

  const addLayout = (seed?: PreviewRow) => {
    let example: LayoutExample | null = null;
    if (seed) {
      example = (examples ?? []).find((e) => (e.anchor ? `${e.anchor}/${e.path}` : e.path).startsWith(seed.path)) ?? null;
      if (!example) {
        const anchor = folders.filter((f) => f === "" || seed.path === f || seed.path.startsWith(`${f}/`)).sort((a, b) => b.length - a.length)[0] ?? "";
        const rel = anchor && seed.path.startsWith(`${anchor}/`) ? seed.path.slice(anchor.length + 1) : seed.path;
        example = kind === "ebook" ? { anchor, path: `${rel}.${seed.formats?.[0] ?? "epub"}` } : { anchor, path: `${rel}/001` };
      }
    } else {
      const list = examples ?? [];
      example = list[list.length - 1] ?? null;
    }
    const draft = example ? draftFromExample(example, kind) : textDraft("");
    onDrafts([...drafts, draft]);
    setSelected(drafts.length);
  };

  const removeLayout = (index: number) => {
    onDrafts(drafts.filter((_, i) => i !== index));
    setSelected((s) => Math.max(0, Math.min(s, drafts.length - 2)));
  };

  const roleOptions = rolesFor(kind);
  const presets = PRESETS[kind];
  const anchorLabel = folders.includes("") ? t("controlAdmin:layout.wholeLibrary") : folders.length === 1 ? folders[0] : t("controlAdmin:layout.selectionCount", { count: folders.length });

  return (
    <div className="layout-build">
      {error && <MessageBox tone="error" title={t("controlAdmin:layout.errorTitle")}>{error}</MessageBox>}

      {!isDefault && (
        <div className="layout-name-row">
          <span className="layout-label">{t("controlAdmin:layout.ruleName")}</span>
          <input type="text" value={name} aria-label={t("controlAdmin:layout.ruleName")} onChange={(event) => onName(event.target.value)} />
          <span className="muted">{nameEdited ? t("controlAdmin:layout.ruleNameCustom") : t("controlAdmin:layout.ruleNameHint")}</span>
        </div>
      )}

      <div>
        <div className="layout-section-head">
          <span className="layout-label">{t("controlAdmin:layout.startFrom")}</span>
          <span className="layout-desc">{t("controlAdmin:layout.startFromHint")}</span>
        </div>
        <div className="layout-presets">
          {presets.map((preset) => (
            <Button variant="bare" key={preset.id} className="layout-preset" title={preset.pattern} onClick={() => pickPreset(preset.pattern)}>
              <b>{t(`controlAdmin:layout.preset_${preset.id}` as never)}</b>
              <span>{preset.pattern}</span>
            </Button>
          ))}
        </div>
      </div>

      <div>
        <div className="layout-section-head">
          <span className="layout-label">{t("controlAdmin:layout.layoutsHeading")}</span>
          <span className="layout-desc">{t("controlAdmin:layout.layoutsHint")}</span>
        </div>
        <div className="layout-cards">
          {drafts.map((draft, index) => {
            const problems = problemsOf(draft, kind);
            const count = counts?.byLayout[index] ?? null;
            const exIndex = draft.example ? (examples ?? []).findIndex((e) => e.path === draft.example!.path && e.anchor === draft.example!.anchor) : -1;
            const segs = labelledSegments(draft);
            const allSegs = draft.segments;
            return (
              <section key={draft.id} className={`layout-card ${index === selected ? "is-selected" : ""}`} onClick={() => setSelected(index)} aria-label={t("controlAdmin:layout.layoutN", { n: index + 1 })}>
                <div className="layout-card-head">
                  <h4>{t("controlAdmin:layout.layoutN", { n: index + 1 })}</h4>
                  <span className="muted">{index === 0 ? t("controlAdmin:layout.triedFirst") : t("controlAdmin:layout.triedNext")}</span>
                  <span className="layout-spacer" />
                  {problems.some((p) => p.kind === "error") ? (
                    <span className="layout-pill is-warn">{t("controlAdmin:layout.fixToCount")}</span>
                  ) : count === null ? (
                    <span className="layout-pill is-quiet">{counting ? t("controlAdmin:layout.counting") : "—"}</span>
                  ) : count === 0 ? (
                    <span className="layout-pill is-none">{t("controlAdmin:layout.matchesNothing")}</span>
                  ) : (
                    <span className="layout-pill is-ok">{noun === "audiobooks" ? t("controlAdmin:layout.audiobooks", { count }) : t("controlAdmin:layout.books", { count })}</span>
                  )}
                  {drafts.length > 1 && (
                    <Button variant="icon" compact title={t("controlAdmin:layout.removeLayout", { n: index + 1 })} aria-label={t("controlAdmin:layout.removeLayout", { n: index + 1 })} onClick={(event) => { event.stopPropagation(); removeLayout(index); }}><X size={15} /></Button>
                  )}
                </div>

                {draft.mode === "builder" ? (
                  <>
                    <div className="layout-example-row">
                      <span className="layout-label">{t("controlAdmin:layout.example")}</span>
                      <span className="layout-nav">
                        <Button variant="icon" compact aria-label={t("controlAdmin:layout.prevExample")} disabled={exIndex <= 0} onClick={() => replace(index, { ...draftFromExample(examples![exIndex - 1], kind), id: draft.id })}><ChevronLeft size={15} /></Button>
                        <Button variant="icon" compact aria-label={t("controlAdmin:layout.nextExample")} disabled={!examples || exIndex >= examples.length - 1} onClick={() => replace(index, { ...draftFromExample(examples![exIndex + 1], kind), id: draft.id })}><ChevronRight size={15} /></Button>
                      </span>
                      <select
                        className="layout-example-select"
                        value={exIndex >= 0 ? String(exIndex) : ""}
                        aria-label={t("controlAdmin:layout.example")}
                        onChange={(event) => { const e = examples?.[Number(event.target.value)]; if (e) replace(index, { ...draftFromExample(e, kind), id: draft.id }); }}
                      >
                        {exIndex < 0 && draft.example && <option value="">{draft.example.path}</option>}
                        {(examples ?? []).map((e, i) => <option key={`${e.anchor}/${e.path}`} value={String(i)}>{e.anchor ? `${e.anchor} / ${e.path}` : e.path}</option>)}
                      </select>
                      <span className="muted">{t("controlAdmin:layout.exampleHint")}</span>
                    </div>

                    <div className="layout-path">
                      {segs.map((seg, si) => (
                        <div key={si} className="layout-segment-wrap">
                          {si > 0 && <span className="layout-sep-slash">/</span>}
                          <div className="layout-segment">
                            {groupsOf(seg).map((g) => {
                              if (g.start < 0) return <span key={`lead-${si}`} className="layout-sep-literal">{g.leading}</span>;
                              const role = seg.roles[g.start] ?? "skip";
                              const parsed = role === "position" && Number.isFinite(Number(g.text)) ? Number(g.text) : null;
                              return (
                                <span key={g.start} className="layout-group-wrap">
                                  <div className={`layout-group is-${role}`}>
                                    <select value={role} aria-label={t("controlAdmin:layout.roleFor", { text: g.text })} onChange={(event) => update(index, (d) => { d.segments[si].roles[g.start] = event.target.value as Role; })}>
                                      {roleOptions.map((r) => <option key={r} value={r}>{roleLabels[r]}</option>)}
                                    </select>
                                    <span className="layout-stem" aria-hidden="true" />
                                    <span className="layout-chip-value" title={t("controlAdmin:layout.splitTitle")} onDoubleClick={() => update(index, (d) => splitGroup(d.segments[si], g.start))}>
                                      {g.text}{parsed !== null && <small>→ {parsed}</small>}
                                    </span>
                                  </div>
                                  {g.sepAfter && (
                                    <Button variant="bare" className="layout-sep-join" title={t("controlAdmin:layout.joinTitle")} onClick={() => update(index, (d) => joinAt(d.segments[si], g.sepAfter!.index))}>{g.sepAfter.text}</Button>
                                  )}
                                </span>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                      {kind === "ebook" ? (
                        <span className="layout-ext">{extensionOf(draft.example)}</span>
                      ) : (
                        <>
                          {allSegs.length > draft.boundary && <span className="layout-sep-slash">/</span>}
                          <span className="layout-ghost">{allSegs.slice(draft.boundary).map((s) => s.tokens.map((tk) => tk.text).join("")).join(" / ")}</span>
                          <span className="layout-tracks"><Music size={13} aria-hidden="true" /> {t("controlAdmin:layout.tracksBeneath")}</span>
                        </>
                      )}
                    </div>

                    {kind === "audiobook" && allSegs.length > 1 && (
                      <div className="layout-boundary">
                        <span className="layout-label">{t("controlAdmin:layout.bookFolder")}</span>
                        <select value={String(draft.boundary)} aria-label={t("controlAdmin:layout.bookFolder")} onChange={(event) => update(index, (d) => { d.boundary = Number(event.target.value); d.segments.forEach((s) => { s.roles = {}; s.joins = []; }); guessRoles(d); })}>
                          {allSegs.slice(0, -1).map((s, i) => <option key={i} value={String(i + 1)}>{s.tokens.map((tk) => tk.text).join("")}</option>)}
                        </select>
                        <span className="muted">{t("controlAdmin:layout.bookFolderHint")}</span>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="layout-text-row">
                    <input
                      type="text"
                      className="layout-text-input"
                      value={draft.text}
                      placeholder={t("controlAdmin:layout.textPlaceholder")}
                      aria-label={t("controlAdmin:layout.advanced")}
                      onChange={(event) => update(index, (d) => { d.text = event.target.value; })}
                    />
                    {examples && examples.length > 0 && (
                      <Button variant="text" onClick={() => replace(index, { ...draftFromExample(examples[0], kind), id: draft.id })}>{t("controlAdmin:layout.useBuilder")}</Button>
                    )}
                  </div>
                )}

                {problems.map((p, i) => (
                  <div key={i} className={`layout-note ${p.kind === "error" ? "is-warn" : "is-info"}`}>
                    {p.kind === "error" ? <AlertTriangle size={15} aria-hidden="true" /> : <Info size={15} aria-hidden="true" />}
                    <span>
                      {p.code === "duplicate" && p.count === 0 ? t("controlAdmin:layout.problemNarratorEbook")
                        : p.code === "duplicate" ? t("controlAdmin:layout.problemDuplicate", { role: roleLabels[p.role ?? "skip"], count: p.count ?? 2 })
                        : p.code === "positionWithoutSeries" ? t("controlAdmin:layout.problemPositionWithoutSeries")
                        : t("controlAdmin:layout.problemEmpty")}
                    </span>
                  </div>
                ))}

                <div className="layout-card-foot">
                  <span className="muted">{t("controlAdmin:layout.readsAs")}</span>
                  <code>{layouts[index] ? humanize(layouts[index], roleLabels) : "—"}</code>
                  {draft.mode === "builder" && (
                    <details className="layout-advanced" onClick={(event) => event.stopPropagation()}>
                      <summary>{t("controlAdmin:layout.advanced")}</summary>
                      <div className="layout-advanced-body">
                        <code>{layouts[index]}</code>
                        <Button variant="text" onClick={() => replace(index, { ...textDraft(layouts[index]), id: draft.id })}>{t("controlAdmin:layout.editText")}</Button>
                        <span className="muted">{t("controlAdmin:layout.advancedNote")}</span>
                      </div>
                    </details>
                  )}
                </div>
              </section>
            );
          })}
          <div>
            <Button variant="text" onClick={() => addLayout()}><Plus size={15} aria-hidden="true" /> {t("controlAdmin:layout.addLayout")}</Button>
          </div>
        </div>
      </div>

      {counts && (
        counts.unmatched.length === 0 ? (
          <div className="layout-unmatched is-clear">
            <Check size={18} aria-hidden="true" />
            <div><strong>{t("controlAdmin:layout.allFit", { folder: anchorLabel })}</strong> <span className="muted">{t("controlAdmin:layout.unmatchedNote")}</span></div>
          </div>
        ) : (
          <div className="layout-unmatched">
            <AlertTriangle size={18} aria-hidden="true" />
            <div className="layout-unmatched-text">
              <strong>{noun === "audiobooks" ? t("controlAdmin:layout.unmatchedHeadingAudiobooks", { count: counts.unmatched.length }) : t("controlAdmin:layout.unmatchedHeading", { count: counts.unmatched.length })}</strong>
              {" "}<span className="muted">{t("controlAdmin:layout.unmatchedBody")}</span>
              <ul>
                {counts.unmatched.slice(0, 4).map((row) => <li key={row.path}>{row.path}</li>)}
                {counts.unmatched.length > 4 && <li>{t("controlAdmin:layout.more", { count: counts.unmatched.length - 4 })}</li>}
              </ul>
            </div>
            <Button variant="secondary" compact onClick={() => addLayout(counts.unmatched[0])}><Plus size={15} aria-hidden="true" /> {t("controlAdmin:layout.addLayoutForThese")}</Button>
          </div>
        )
      )}

      {counts && (
        <div className="layout-summary muted">
          {t("controlAdmin:layout.matchesSummary", { matched: counts.total - counts.unmatched.length, total: counts.total })}
        </div>
      )}
    </div>
  );
}
