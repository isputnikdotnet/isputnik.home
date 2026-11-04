import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Pencil } from "lucide-react";
import { api } from "../../api";
import { controlHref } from "../../router";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { TitleLookup, type LookupDetails, type LookupField } from "./TitleLookup";
import { TitlePictures } from "./TitlePictures";
import { VIDEO_API, type VideoKind, type VideoMovie, type VideoShow } from "./types";

// Edit (admins): a film's or show's details over what the scan found — the
// .nfo, the folder's name, TMDB. The engine keeps them through every rescan
// (its edits.ts) and every screen reads them, the TV's too. A field left empty
// is automatic again; the dialog says what that would be.
//
// Tabs, as a book's editor has: Details, Genres and (films) Set are saved by Save;
// Lookup (what Fix match was) fills them from a TMDB title and saves that match
// with them; Pictures changes the poster and backdrop at once.

interface Field<T> {
  edited: T | null;
  automatic: T | null;
}

interface EditState {
  kind: VideoKind;
  title: Field<string>;
  originalTitle: Field<string>;
  sortTitle: Field<string>;
  year: Field<number>;
  plot: Field<string>;
  genres: Field<string[]>;
  /** Films only (engine 0.24.0+): the set by hand, and the one found. */
  set?: { edited: SetEdit | null; automatic: string | null };
}

type SetEdit = { mode: "none" } | { mode: "named"; name: string; order: number | null };
type SetMode = "auto" | "none" | "named";

type TextField = "title" | "originalTitle" | "sortTitle" | "year" | "plot";
type Tab = "details" | "genres" | "set" | "lookup" | "pictures";
/** A match to save with the details: a TMDB title, or back to the automatic one (null id). */
type PendingMatch = { tmdbId: string; tmdbKind: "movie" | "tv"; title: string } | { tmdbId: null };

const sameList = (a: string[] | null, b: string[] | null) => JSON.stringify(a) === JSON.stringify(b);

export function EditTitleModal({ kind, title, onClose, onSaved }: {
  kind: VideoKind;
  title: VideoShow | VideoMovie;
  onClose: () => void;
  /** After a save, and after each change of picture: the title as the family now sees it. */
  onSaved: (title: VideoShow | VideoMovie) => void;
}) {
  const { t } = useTranslation();
  const url = `${VIDEO_API}/admin/titles/${encodeURIComponent(title.id)}/edit`;
  const [state, setState] = useState<EditState | null>(null);
  const [draft, setDraft] = useState<Record<TextField, string>>({ title: "", originalTitle: "", sortTitle: "", year: "", plot: "" });
  /** null: the genres found. */
  const [genres, setGenres] = useState<string[] | null>(null);
  const [allGenres, setAllGenres] = useState<string[] | null>(null);
  const [pendingMatch, setPendingMatch] = useState<PendingMatch | null>(null);
  const [setMode, setSetMode] = useState<SetMode>("auto");
  const [setName, setSetName] = useState("");
  const [setOrder, setSetOrder] = useState("");
  const [setNames, setSetNames] = useState<string[]>([]);
  const [tab, setTab] = useState<Tab>("details");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const ownKind = kind === "shows" ? "tv" : "movie";

  useEffect(() => {
    let live = true;
    Promise.all([
      api<EditState>(url),
      api<{ genres: { name: string }[] }>(`${VIDEO_API}/admin/genres`).catch(() => ({ genres: [] })),
      kind === "movies" ? api<{ sets: { name: string }[] }>(`${VIDEO_API}/admin/sets/names`).catch(() => ({ sets: [] })) : Promise.resolve({ sets: [] })
    ])
      .then(([loaded, list, sets]) => {
        if (!live) return;
        setState(loaded);
        setDraft({
          title: loaded.title.edited ?? "",
          originalTitle: loaded.originalTitle.edited ?? "",
          sortTitle: loaded.sortTitle.edited ?? "",
          year: loaded.year.edited !== null ? String(loaded.year.edited) : "",
          plot: loaded.plot.edited ?? ""
        });
        setGenres(loaded.genres.edited);
        setAllGenres(list.genres.map((genre) => genre.name));
        const setEdit = loaded.set?.edited ?? null;
        setSetMode(setEdit ? setEdit.mode : "auto");
        setSetName(setEdit?.mode === "named" ? setEdit.name : "");
        setSetOrder(setEdit?.mode === "named" && setEdit.order !== null ? String(setEdit.order) : "");
        setSetNames(sets.sets.map((set) => set.name));
      })
      .catch((err: unknown) => { if (live) setError(err instanceof Error ? err.message : t("video.edit.loadFailed")); });
    return () => { live = false; };
  }, [url, t, kind]);

  const yearValue = (value: string) => (/^\d{4}$/.test(value.trim()) ? Number(value.trim()) : null);
  const edits = {
    title: draft.title.trim() || null,
    originalTitle: draft.originalTitle.trim() || null,
    sortTitle: draft.sortTitle.trim() || null,
    year: yearValue(draft.year),
    plot: draft.plot.trim() || null,
    genres: genres && genres.length > 0 ? genres : null
  };
  const setEditNow: SetEdit | null = setMode === "none"
    ? { mode: "none" }
    : setMode === "named" && setName.trim()
      ? { mode: "named", name: setName.trim().replace(/\s+/g, " "), order: /^\d{1,3}$/.test(setOrder.trim()) ? Number(setOrder.trim()) : null }
      : null;
  const setDirty = state?.set !== undefined && JSON.stringify(setEditNow) !== JSON.stringify(state.set.edited);
  const dirty = state !== null && (
    setDirty ||
    edits.title !== state.title.edited ||
    edits.originalTitle !== state.originalTitle.edited ||
    edits.sortTitle !== state.sortTitle.edited ||
    edits.year !== state.year.edited ||
    edits.plot !== state.plot.edited ||
    !sameList(edits.genres, state.genres.edited)
  );

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      let updated: VideoShow | VideoMovie | undefined;
      if (pendingMatch) {
        const body = pendingMatch.tmdbId === null
          ? { tmdbId: null }
          : { tmdbId: pendingMatch.tmdbId, ...(pendingMatch.tmdbKind !== ownKind ? { tmdbKind: pendingMatch.tmdbKind } : {}) };
        const answer = await api<{ show?: VideoShow; movie?: VideoMovie }>(`${VIDEO_API}/admin/metadata/items/${encodeURIComponent(title.id)}`, {
          method: "PUT",
          body: JSON.stringify(body)
        });
        updated = answer.show ?? answer.movie;
      }
      if (dirty) {
        const answer = await api<{ show?: VideoShow; movie?: VideoMovie }>(url, {
          method: "PUT",
          // The set only when it changed: saving it works every set out again.
          body: JSON.stringify(setDirty ? { ...edits, set: setEditNow } : edits)
        });
        updated = answer.show ?? answer.movie ?? updated;
      }
      if (updated) onSaved(updated);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("video.edit.failedTitle"));
    } finally {
      setSaving(false);
    }
  };

  const found = (value: string | number | null) =>
    value === null || value === "" ? t("video.edit.automaticNone") : t("video.edit.automatic", { value: String(value) });

  const textField = (key: TextField, label: string, options: { multiline?: boolean; numeric?: boolean } = {}) => {
    const automatic = state?.[key].automatic ?? null;
    const value = draft[key];
    const set = (next: string) => setDraft((current) => ({ ...current, [key]: next }));
    return (
      <div className="video-edit-field">
        <label className="field">
          <span>
            {label}
            {value.trim() && <small className="video-edit-badge">{t("video.edit.edited")}</small>}
          </span>
          {options.multiline ? (
            <textarea rows={6} value={value} placeholder={automatic === null ? "" : String(automatic)} onChange={(event) => set(event.target.value)} />
          ) : (
            <input
              value={value}
              inputMode={options.numeric ? "numeric" : undefined}
              maxLength={options.numeric ? 4 : 300}
              placeholder={automatic === null ? "" : String(automatic)}
              onChange={(event) => set(options.numeric ? event.target.value.replace(/\D/g, "") : event.target.value)}
            />
          )}
        </label>
        <div className="video-edit-found">
          {!options.multiline && <small className="muted">{found(automatic)}</small>}
          {value.trim() && (
            <Button variant="text" onClick={() => set("")}>{t("video.edit.useAutomatic")}</Button>
          )}
        </div>
      </div>
    );
  };

  const picked = new Set(genres ?? []);
  const toggle = (name: string) => {
    // The first pick starts from the genres found, so one click adds or drops one of them.
    const next = new Set(genres ?? state?.genres.automatic ?? []);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setGenres(next.size > 0 ? (allGenres ?? []).filter((genre) => next.has(genre)).concat([...next].filter((genre) => !(allGenres ?? []).includes(genre))) : null);
  };

  /** Lookup's choice: the ticked fields into the form, the match to be saved with it. */
  const useLookup = (details: LookupDetails, fields: LookupField[]) => {
    const take = new Set(fields);
    setDraft((current) => ({
      ...current,
      ...(take.has("title") && details.title ? { title: details.title } : {}),
      ...(take.has("originalTitle") && details.originalTitle ? { originalTitle: details.originalTitle } : {}),
      ...(take.has("year") && details.year ? { year: String(details.year) } : {}),
      ...(take.has("plot") && details.plot ? { plot: details.plot } : {})
    }));
    if (take.has("genres") && details.genres.length > 0) setGenres(details.genres);
    const match = title.tmdbMatch;
    const already = match?.id === details.tmdbId && (match.kind ?? ownKind) === details.kind && match.locked;
    setPendingMatch(already ? null : { tmdbId: details.tmdbId, tmdbKind: details.kind, title: details.title ?? details.tmdbId });
    setTab("details");
  };

  const shown = (key: TextField) => {
    const automatic = state?.[key].automatic;
    return draft[key].trim() || (automatic === null || automatic === undefined ? "" : String(automatic));
  };

  return (
    <Modal
      variant="panel"
      title={t("video.edit.title")}
      subtitle={title.title}
      icon={<Pencil size={20} />}
      className="video-edit-modal"
      busy={saving}
      onClose={onClose}
    >
      <div className="modal-tabs" role="tablist">
        <Button variant="tab" className="modal-tab" selected={tab === "details"} onClick={() => setTab("details")}>{t("video.edit.tabDetails")}</Button>
        <Button variant="tab" className="modal-tab" selected={tab === "genres"} onClick={() => setTab("genres")}>{t("video.edit.tabGenres")}</Button>
        {kind === "movies" && (
          <Button variant="tab" className="modal-tab" selected={tab === "set"} onClick={() => setTab("set")}>{t("video.edit.tabSet")}</Button>
        )}
        <Button variant="tab" className="modal-tab" selected={tab === "lookup"} onClick={() => setTab("lookup")}>{t("video.edit.tabLookup")}</Button>
        <Button variant="tab" className="modal-tab" selected={tab === "pictures"} onClick={() => setTab("pictures")}>{t("video.edit.tabPictures")}</Button>
      </div>
      <div className="modal-tab-content">
        {error && <MessageBox tone="error" title={state ? t("video.edit.failedTitle") : t("video.edit.loadFailed")}>{error}</MessageBox>}
        {!state && !error && <p className="muted">{t("video.edit.loading")}</p>}
        {pendingMatch && tab !== "lookup" && (
          <MessageBox tone="info" title={t("video.edit.pendingTitle")}>
            {pendingMatch.tmdbId === null
              ? t("video.edit.pendingAutomatic")
              : t("video.edit.pendingMatch", { title: pendingMatch.title, id: pendingMatch.tmdbId })}
          </MessageBox>
        )}

        {state && tab === "details" && (
          <div className="video-edit-details">
            <p className="muted">{t("video.edit.hint")}</p>
            {textField("title", t("video.edit.fieldTitle"))}
            {textField("originalTitle", t("video.edit.fieldOriginalTitle"))}
            <div className="video-edit-pair">
              {textField("year", t("video.edit.fieldYear"), { numeric: true })}
              {textField("sortTitle", t("video.edit.fieldSortTitle"))}
            </div>
            {textField("plot", t("video.edit.fieldPlot"), { multiline: true })}
          </div>
        )}

        {state && tab === "genres" && (
          <div className="video-edit-genres">
            <p className="muted">{t("video.edit.genresHint")}</p>
            <p className="video-edit-found">
              <small className="muted">
                {state.genres.automatic && state.genres.automatic.length > 0
                  ? t("video.edit.genresFound", { genres: state.genres.automatic.join(", ") })
                  : t("video.edit.genresNoneFound")}
              </small>
              {genres && (
                <Button variant="text" onClick={() => setGenres(null)}>{t("video.edit.genresAutomatic")}</Button>
              )}
            </p>
            {allGenres && allGenres.length === 0 && !genres ? (
              <p className="muted">
                {t("video.edit.genresEmpty")} <a href={controlHref("genres")}>{t("video.edit.genresManage")}</a>
              </p>
            ) : (
              <ul className="video-edit-genre-list">
                {[...new Set([...(allGenres ?? []), ...(genres ?? [])])].map((name) => {
                  // With nothing picked, the genres found show as they are.
                  const on = genres ? picked.has(name) : (state.genres.automatic ?? []).includes(name);
                  return (
                    <li key={name}>
                      <Button
                        variant="chip"
                        className={`video-edit-genre${on ? " is-on" : ""}${on && !genres ? " is-found" : ""}`}
                        aria-pressed={on}
                        onClick={() => toggle(name)}
                      >
                        {on && <Check size={14} aria-hidden="true" />}
                        {name}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {state && tab === "set" && (
          <fieldset className="video-edit-set">
            <legend className="sr-only">{t("video.edit.tabSet")}</legend>
            <p className="muted">{t("video.edit.setHint")}</p>
            <label className="video-edit-set-choice">
              <input type="radio" name="video-set" checked={setMode === "auto"} onChange={() => setSetMode("auto")} />
              <span>
                <strong>{t("video.edit.setAutomatic")}</strong>
                <small className="muted">
                  {state.set?.automatic ? t("video.edit.setFound", { name: state.set.automatic }) : t("video.edit.setFoundNone")}
                </small>
              </span>
            </label>
            <label className="video-edit-set-choice">
              <input type="radio" name="video-set" checked={setMode === "named"} onChange={() => setSetMode("named")} />
              <span>
                <strong>{t("video.edit.setNamed")}</strong>
                <small className="muted">{t("video.edit.setNamedHint")}</small>
              </span>
            </label>
            {setMode === "named" && (
              <div className="video-edit-pair video-edit-set-fields">
                <label className="field">
                  <span>{t("video.edit.setName")}</span>
                  <input value={setName} list="video-set-names" maxLength={200} onChange={(event) => setSetName(event.target.value)} />
                  <datalist id="video-set-names">
                    {setNames.map((name) => <option key={name} value={name} />)}
                  </datalist>
                </label>
                <label className="field">
                  <span>{t("video.edit.setOrder")}</span>
                  <input value={setOrder} inputMode="numeric" maxLength={3} onChange={(event) => setSetOrder(event.target.value.replace(/\D/g, ""))} />
                </label>
              </div>
            )}
            <label className="video-edit-set-choice">
              <input type="radio" name="video-set" checked={setMode === "none"} onChange={() => setSetMode("none")} />
              <span>
                <strong>{t("video.edit.setNone")}</strong>
                <small className="muted">{t("video.edit.setNoneHint")}</small>
              </span>
            </label>
          </fieldset>
        )}

        {state && tab === "lookup" && (
          <TitleLookup
            kind={kind}
            title={title}
            current={{
              title: shown("title"),
              originalTitle: shown("originalTitle"),
              year: shown("year"),
              plot: shown("plot"),
              genres: genres ?? state.genres.automatic ?? []
            }}
            onUse={useLookup}
            onAutomatic={() => { setPendingMatch({ tmdbId: null }); setTab("details"); }}
          />
        )}

        {tab === "pictures" && <TitlePictures kind={kind} title={title} onChanged={onSaved} />}

        {tab !== "lookup" && (
          <div className="modal-actions">
            {tab === "pictures" && <small className="muted video-edit-pictures-note">{t("video.edit.picturesNote")}</small>}
            <Button variant="secondary" disabled={saving} onClick={onClose}>
              {dirty || pendingMatch ? t("common.cancel") : t("common.close")}
            </Button>
            <Button variant="primary" disabled={saving || !state || (!dirty && !pendingMatch) || (setMode === "named" && !setName.trim())} onClick={() => void save()}>
              {saving ? t("video.edit.saving") : t("video.edit.save")}
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
