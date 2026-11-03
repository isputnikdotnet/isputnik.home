import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Eye, EyeOff, LayoutList, Pencil, Plus } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { ChoiceGroup } from "../../shared/ChoiceGroup";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { Field } from "../../shared/Field";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { SelectField } from "../../shared/SelectField";
import {
  VIDEO_HOME_API, VIDEO_ROWS_MAX, kindWord, newRowId, rowName,
  type VideoLayout, type VideoRow, type VideoRowKind, type VideoRowSort, type VideoTitlesRow
} from "./rows";
import { VIDEO_API, type VideoLibraryRef } from "./types";

type RowType = VideoRow["type"];

// Customize on the video page (docs/video-home-rows-plan.md): the household's
// rows, in order, each shown or hidden, and Add row. Admins only; what is saved
// is everyone's page. Nothing is saved until Save rows.
export function VideoRowsEditor({ layout, libraries, onClose, onSaved }: {
  layout: VideoLayout;
  libraries: VideoLibraryRef[];
  onClose: () => void;
  onSaved: (layout: VideoLayout) => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<VideoRow[]>(layout.rows);
  /** The row being added or changed; its index, or -1 for a new one. */
  const [editing, setEditing] = useState<{ index: number; row: VideoRow } | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState<"ask" | "busy" | null>(null);
  const [error, setError] = useState("");
  const libraryNames = Object.fromEntries(libraries.map((entry) => [entry.id, entry.name]));

  const move = (index: number, by: number) => {
    const to = index + by;
    if (to < 0 || to >= rows.length) return;
    const next = rows.slice();
    [next[index], next[to]] = [next[to], next[index]];
    setRows(next);
  };
  const change = (index: number, row: VideoRow) => setRows(rows.map((each, at) => (at === index ? row : each)));

  const send = async (request: Promise<VideoLayout>) => {
    setError("");
    try {
      onSaved(await request);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("video.rows.saveFailed"));
      return false;
    }
    return true;
  };
  const save = async () => {
    setSaving(true);
    await send(api<VideoLayout>(VIDEO_HOME_API, { method: "PUT", body: JSON.stringify({ rows }) }));
    setSaving(false);
  };
  const reset = async () => {
    setResetting("busy");
    const done = await send(api<VideoLayout>(VIDEO_HOME_API, { method: "DELETE" }));
    setResetting(done ? null : "ask");
  };

  const busy = saving || resetting === "busy";
  const describe = (row: VideoRow) => {
    if (row.type === "continue") return t("video.rows.typeContinueHint");
    if (row.type === "sets") return t("video.rows.typeSetsHint");
    const sort = row.sort === "added" ? t("video.sortAdded") : row.sort === "year" ? t("video.sortYear") : t("video.sortTitle");
    const where = row.libraries.length > 0 ? row.libraries.map((id) => libraryNames[id] ?? id).join(", ") : t("video.rows.everyLibrary");
    return [kindWord(row.kind, t), where, sort].join(" · ");
  };

  return (
    <Modal variant="panel" title={t("video.rows.title")} icon={<LayoutList size={20} />} className="video-rows-modal" busy={busy} onClose={onClose}>
      <div className="modal-tab-content">
        {editing ? (
          <RowForm
            row={editing.row}
            isNew={editing.index < 0}
            libraries={libraries}
            libraryNames={libraryNames}
            onCancel={() => setEditing(null)}
            onDone={(row) => {
              if (editing.index < 0) setRows([...rows, row]);
              else change(editing.index, row);
              setEditing(null);
            }}
          />
        ) : (
          <>
            <p className="muted">{t("video.rows.hint")}</p>
            {error && <MessageBox tone="error" title={t("video.rows.saveFailed")}>{error}</MessageBox>}
            <ol className="video-rows-list">
              {rows.map((row, index) => {
                const name = rowName(row, t, libraryNames);
                return (
                  <li key={row.id} className={row.hidden ? "is-hidden" : undefined}>
                    <span className="video-rows-text">
                      <strong>{name}</strong>
                      <span>{row.hidden ? `${t("video.rows.hidden")} · ${describe(row)}` : describe(row)}</span>
                    </span>
                    <Button variant="icon" aria-label={t("video.rows.moveUp", { name })} title={t("video.rows.moveUp", { name })} disabled={index === 0} onClick={() => move(index, -1)}>
                      <ArrowUp size={16} aria-hidden="true" />
                    </Button>
                    <Button variant="icon" aria-label={t("video.rows.moveDown", { name })} title={t("video.rows.moveDown", { name })} disabled={index === rows.length - 1} onClick={() => move(index, 1)}>
                      <ArrowDown size={16} aria-hidden="true" />
                    </Button>
                    <Button
                      variant="icon"
                      aria-label={row.hidden ? t("video.rows.show", { name }) : t("video.rows.hide", { name })}
                      title={row.hidden ? t("video.rows.show", { name }) : t("video.rows.hide", { name })}
                      onClick={() => change(index, { ...row, hidden: !row.hidden })}
                    >
                      {row.hidden ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
                    </Button>
                    <Button variant="icon" aria-label={t("video.rows.edit", { name })} title={t("video.rows.edit", { name })} onClick={() => setEditing({ index, row })}>
                      <Pencil size={16} aria-hidden="true" />
                    </Button>
                    <Button variant="text" onClick={() => setRows(rows.filter((_, at) => at !== index))}>{t("video.rows.remove")}</Button>
                  </li>
                );
              })}
            </ol>
            {rows.length === 0 && <p className="muted">{t("video.rows.none")}</p>}
            <Button
              variant="secondary"
              disabled={rows.length >= VIDEO_ROWS_MAX}
              title={rows.length >= VIDEO_ROWS_MAX ? t("video.rows.full", { max: VIDEO_ROWS_MAX }) : undefined}
              onClick={() => setEditing({ index: -1, row: { id: newRowId(), type: "titles", kind: "all", libraries: [], genres: [], sort: "added" } })}
            >
              <Plus size={16} aria-hidden="true" />
              {t("video.rows.add")}
            </Button>
            <div className="modal-actions">
              {layout.custom && (
                <Button variant="text" disabled={busy} onClick={() => setResetting("ask")}>{t("video.rows.reset")}</Button>
              )}
              <Button variant="secondary" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
              <Button variant="primary" disabled={busy} onClick={() => void save()}>{saving ? t("video.rows.saving") : t("video.rows.save")}</Button>
            </div>
          </>
        )}
      </div>
      {resetting && (
        <ConfirmDialog
          title={t("video.rows.resetTitle")}
          confirmLabel={t("video.rows.resetConfirm")}
          busyLabel={t("video.rows.resetting")}
          busy={resetting === "busy"}
          onConfirm={() => void reset()}
          onCancel={() => setResetting(null)}
        >
          {t("video.rows.resetBody")}
        </ConfirmDialog>
      )}
    </Modal>
  );
}

/** One row's settings: what it is, and for a list of titles what it asks for. */
function RowForm({ row, isNew, libraries, libraryNames, onCancel, onDone }: {
  row: VideoRow;
  isNew: boolean;
  libraries: VideoLibraryRef[];
  libraryNames: Record<string, string>;
  onCancel: () => void;
  onDone: (row: VideoRow) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<VideoRow>(row);
  const [genres, setGenres] = useState<string[]>([]);
  const titles: VideoTitlesRow = draft.type === "titles" ? draft : { id: draft.id, type: "titles", kind: "all", libraries: [], genres: [], sort: "added" };

  useEffect(() => {
    let live = true;
    api<{ genres: string[] }>(`${VIDEO_API}/genres`)
      .then((payload) => { if (live) setGenres(payload.genres); })
      .catch(() => { if (live) setGenres([]); });
    return () => { live = false; };
  }, []);

  const setType = (type: RowType) => {
    const common = { id: draft.id, title: draft.title, hidden: draft.hidden };
    setDraft(type === "titles" ? { ...titles, ...common } : { ...common, type });
  };
  const setTitles = (patch: Partial<VideoTitlesRow>) => setDraft({ ...titles, title: draft.title, hidden: draft.hidden, ...patch });
  const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((each) => each !== value) : [...list, value]);
  // Libraries of the other kind say nothing in a row of one kind.
  const shownLibraries = libraries.filter((entry) => titles.kind === "all" || entry.kind === titles.kind);
  // A genre picked before the engine dropped it stays visible, so it can be unpicked.
  const genreOptions = [...new Set([...genres, ...titles.genres])];

  return (
    <div className="video-row-form">
      <h3>{isNew ? t("video.rows.addTitle") : t("video.rows.editTitle")}</h3>
      {isNew && (
        <ChoiceGroup<RowType>
          legend={t("video.rows.typeLegend")}
          value={draft.type}
          onChange={setType}
          options={[
            { value: "titles", label: t("video.rows.typeTitles"), description: t("video.rows.typeTitlesHint") },
            { value: "continue", label: t("video.continueWatching"), description: t("video.rows.typeContinueHint") },
            { value: "sets", label: t("video.viewSets"), description: t("video.rows.typeSetsHint") }
          ]}
        />
      )}
      {draft.type === "titles" && (
        <>
          <SelectField<VideoRowKind>
            label={t("video.rows.fieldKind")}
            value={titles.kind}
            onChange={(kind) => setTitles({ kind, libraries: titles.libraries.filter((id) => kind === "all" || libraries.find((entry) => entry.id === id)?.kind === kind) })}
            options={[
              { value: "all", label: t("video.rows.kindBoth") },
              { value: "movies", label: t("video.movies") },
              { value: "shows", label: t("video.shows") }
            ]}
          />
          {shownLibraries.length > 1 && (
            <fieldset className="video-row-checks">
              <legend>{t("video.rows.fieldLibraries")}</legend>
              <p className="muted">{t("video.rows.fieldLibrariesHint")}</p>
              {shownLibraries.map((entry) => (
                <label key={entry.id}>
                  <input type="checkbox" checked={titles.libraries.includes(entry.id)} onChange={() => setTitles({ libraries: toggle(titles.libraries, entry.id) })} />
                  <span>{entry.name}</span>
                </label>
              ))}
            </fieldset>
          )}
          {genreOptions.length > 0 && (
            <fieldset className="video-row-checks">
              <legend>{t("video.rows.fieldGenres")}</legend>
              <p className="muted">{t("video.rows.fieldGenresHint")}</p>
              {genreOptions.map((genre) => (
                <label key={genre}>
                  <input type="checkbox" checked={titles.genres.includes(genre)} onChange={() => setTitles({ genres: toggle(titles.genres, genre) })} />
                  <span>{genre}</span>
                </label>
              ))}
            </fieldset>
          )}
          <SelectField<VideoRowSort>
            label={t("video.rows.fieldSort")}
            value={titles.sort}
            onChange={(sort) => setTitles({ sort })}
            options={[
              { value: "added", label: t("video.sortAdded") },
              { value: "year", label: t("video.sortYear") },
              { value: "title", label: t("video.sortTitle") }
            ]}
          />
        </>
      )}
      <Field
        label={t("video.rows.fieldTitle")}
        value={draft.title ?? ""}
        required={false}
        placeholder={rowName({ ...draft, title: undefined }, t, libraryNames)}
        onChange={(value) => setDraft({ ...draft, title: value.trim() ? value.slice(0, 80) : undefined })}
      />
      <div className="modal-actions">
        <Button variant="secondary" onClick={onCancel}>{t("common.cancel")}</Button>
        <Button variant="primary" onClick={() => onDone(draft)}>{isNew ? t("video.rows.addDone") : t("common.done")}</Button>
      </div>
    </div>
  );
}
