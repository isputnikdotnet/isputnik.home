import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Drama, EyeOff, GitMerge, List, Pencil, Plus, Trash2, X } from "lucide-react";
import { api } from "../../../api";
import { controlHref } from "../../../router";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { SelectField } from "../../../shared/SelectField";
import { ControlSectionHead } from "../ControlSectionHead";
import { isRunning, useAppsStatus } from "./AppsSection";
import "../../../styles/genres.css";

// Library › Video genres: the video engine's own genre list, kept the way the
// books' categories are. Films and shows carry raw words from their .nfo files
// and from TMDB ("Comedy", "комедия", "Sci-Fi & Fantasy"); here they are mapped
// onto genres the family chose, or hidden. The engine applies the map wherever a
// genre shows — cards, filters, Video home's rows, the TV app, Stremio — so a
// change here needs no rescan. Every answer is the whole page again.

interface Genre {
  id: string;
  name: string;
  keywords: string[];
  titles: number;
}

interface GenreWord {
  value: string;
  titles: number;
  state: "hidden" | "keyword" | "genre" | "unsorted";
  genres: string[];
}

interface Overview {
  genres: Genre[];
  words: GenreWord[];
}

export function GenresSection() {
  const { t } = useTranslation(["common", "control"]);
  const { apps, error: appsError } = useAppsStatus();
  const video = apps?.find((app) => app.id === "video") ?? null;
  const running = video ? isRunning(video) : false;

  return (
    <>
      <ControlSectionHead section="genres" icon={<Drama size={30} />} iconClassName="blue" description={t("control:genres.description")} />
      {appsError && <MessageBox tone="error" title={t("control:genres.loadFailed")}>{appsError}</MessageBox>}
      {!apps && !appsError && <p className="muted">{t("control:ui.loading")}</p>}
      {apps && video && running && <GenresBody prefix={video.prefix} />}
      {apps && !running && (
        <MessageBox tone="info" title={t("control:genres.unavailableTitle")}>
          {t("control:genres.unavailableBody")} <a href={controlHref("dashboard")}>{t("control:genres.openDashboard")}</a>
        </MessageBox>
      )}
    </>
  );
}

function GenresBody({ prefix }: { prefix: string }) {
  const { t } = useTranslation(["common", "control"]);
  const url = `${prefix}/api/admin/genres`;
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [creating, setCreating] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [seedLanguage, setSeedLanguage] = useState<"en" | "ru">("ru");

  const load = useCallback(async () => {
    try {
      setData(await api<Overview>(url));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("control:genres.loadFailed"));
    }
  }, [url, t]);

  useEffect(() => { void load(); }, [load]);

  /** One change: the answer is the page as it now is. Throws so a dialog can stay open. */
  const change = useCallback(async (key: string, path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown) => {
    setBusy(key);
    setError("");
    try {
      setData(await api<Overview>(`${url}${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    } catch (err) {
      const message = err instanceof Error ? err.message : t("control:genres.errorTitle");
      setError(message);
      throw err;
    } finally {
      setBusy("");
    }
  }, [url, t]);
  const quietly = (work: Promise<unknown>) => { work.catch(() => undefined); };

  if (!data) {
    return error ? <MessageBox tone="error" title={t("control:genres.loadFailed")}>{error}</MessageBox> : <p className="muted">{t("control:ui.loading")}</p>;
  }

  const unsorted = data.words.filter((word) => word.state === "unsorted");
  const hidden = data.words.filter((word) => word.state === "hidden");
  const editingGenre = data.genres.find((genre) => genre.id === editing) ?? null;
  const genreOptions = data.genres.map((genre) => ({ value: genre.id, label: genre.name }));

  return (
    <>
      <div className="genres-head-actions">
        <Button variant="primary" onClick={() => setCreating("")}>
          <Plus size={16} aria-hidden="true" /> {t("control:genres.createGenre")}
        </Button>
      </div>

      <GenresHelp open={data.genres.length === 0} />

      {error && !creating && !editing && <MessageBox tone="error" title={t("control:genres.errorTitle")}>{error}</MessageBox>}

      {data.genres.length === 0 ? (
        <section className="genres-card">
          <p className="muted">{t("control:genres.empty")}</p>
          <h2>{t("control:genres.seedTitle")}</h2>
          <p>{t("control:genres.seedBody")}</p>
          <div className="genres-seed-row">
            <SelectField
              label={t("control:genres.seedLanguage")}
              value={seedLanguage}
              onChange={setSeedLanguage}
              options={[{ value: "ru", label: t("control:genres.languageRu") }, { value: "en", label: t("control:genres.languageEn") }]}
            />
            <Button variant="primary" disabled={busy !== ""} onClick={() => quietly(change("seed", "/seed", "POST", { language: seedLanguage }))}>
              {busy === "seed" ? t("control:genres.seeding") : t("control:genres.seed")}
            </Button>
          </div>
        </section>
      ) : (
        <div className="datagrid-wrap">
          <table className="datagrid datagrid-phone-stack stack-actions-below">
            <thead>
              <tr>
                <th>{t("control:genres.thName")}</th>
                <th className="col-num">{t("control:genres.thTitles")}</th>
                <th>{t("control:genres.thKeywords")}</th>
                <th className="col-actions"></th>
              </tr>
            </thead>
            <tbody>
              {data.genres.map((genre) => (
                <tr key={genre.id}>
                  <td className="col-title"><strong>{genre.name}</strong></td>
                  <td className="col-num datagrid-muted" data-label={t("control:genres.thTitles")}>{genre.titles}</td>
                  <td className="datagrid-muted genres-keyword-cell" data-label={t("control:genres.thKeywords")}>
                    {genre.keywords.length > 0 ? genre.keywords.join(", ") : t("control:genres.noKeywords")}
                  </td>
                  <td className="col-actions">
                    <Button variant="secondary" compact onClick={() => setEditing(genre.id)}>
                      <Pencil size={14} aria-hidden="true" /> {t("control:genres.edit")}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="genres-card">
        <h2>{t("control:genres.unsortedTitle")}</h2>
        <p className="muted">{t("control:genres.unsortedBody")}</p>
        {unsorted.length === 0 ? (
          <p className="management-empty">{t("control:genres.unsortedNone")}</p>
        ) : (
          <ul className="genres-words">
            {unsorted.map((word) => (
              <li key={word.value} className="genres-word">
                <div className="genres-word-copy">
                  <strong title={word.value}>{word.value}</strong>
                  <span className="muted">{t("control:genres.titleCount", { count: word.titles })}</span>
                </div>
                <div className="genres-word-actions">
                  {data.genres.length > 0 && (
                    <SelectField
                      compact
                      hideLabel
                      label={t("control:genres.addTo")}
                      value=""
                      disabled={busy !== ""}
                      options={[{ value: "", label: t("control:genres.addToPlaceholder") }, ...genreOptions]}
                      onChange={(id) => { if (id) quietly(change(`word:${word.value}`, `/${encodeURIComponent(id)}/keywords`, "POST", { word: word.value })); }}
                    />
                  )}
                  <Button variant="secondary" compact disabled={busy !== ""} onClick={() => setCreating(word.value)}>
                    <Plus size={14} aria-hidden="true" /> {t("control:genres.createFromWord")}
                  </Button>
                  <Button variant="text" disabled={busy !== ""} onClick={() => quietly(change(`word:${word.value}`, "/hidden", "POST", { word: word.value }))}>
                    <EyeOff size={14} aria-hidden="true" /> {t("control:genres.hide")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {hidden.length > 0 && (
        <section className="genres-card">
          <h2>{t("control:genres.hiddenTitle")}</h2>
          <p className="muted">{t("control:genres.hiddenBody")}</p>
          <ul className="genres-chips">
            {hidden.map((word) => (
              <li key={word.value} className="genres-chip">
                <span>{word.value}</span>
                <small className="muted">{word.titles}</small>
                <Button
                  variant="icon"
                  disabled={busy !== ""}
                  aria-label={t("control:genres.showAgainAria", { word: word.value })}
                  title={t("control:genres.showAgain")}
                  onClick={() => quietly(change(`hidden:${word.value}`, "/hidden/remove", "POST", { word: word.value }))}
                >
                  <X size={14} aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {creating !== null && (
        <CreateGenreDialog
          initial={creating}
          busy={busy === "create"}
          error={error}
          onCancel={() => { setCreating(null); setError(""); }}
          onCreate={async (name) => {
            // Created from an unsorted word: the word names it, so it lands there by itself.
            await change("create", "", "POST", { name });
            setCreating(null);
          }}
        />
      )}

      {editingGenre && (
        <EditGenreDialog
          genre={editingGenre}
          others={data.genres.filter((genre) => genre.id !== editingGenre.id)}
          busy={busy}
          error={error}
          change={change}
          onClose={() => { setEditing(null); setError(""); }}
        />
      )}
    </>
  );
}

/** The four ways a genre a film arrives with can end up, with an example each
 *  — the same panel Categories has. Open until the list has genres. */
function GenresHelp({ open }: { open?: boolean }) {
  const { t } = useTranslation(["common", "control"]);
  const cases = [
    ["helpKeywordTitle", "helpKeywordBody"],
    ["helpNameTitle", "helpNameBody"],
    ["helpFoundTitle", "helpFoundBody"],
    ["helpHiddenTitle", "helpHiddenBody"]
  ] as const;
  return (
    <details className="category-help-panel category-help-disclosure" open={open}>
      <summary className="category-help-summary">
        <List size={18} aria-hidden="true" />
        <span>{t("control:genres.helpSummary")}</span>
      </summary>
      <p className="category-help-note">{t("control:genres.helpIntro")}</p>
      <div className="category-help-grid">
        {cases.map(([title, body]) => (
          <div className="category-help-item" key={title}>
            <strong>{t(`control:genres.${title}`)}</strong>
            <span>{t(`control:genres.${body}`)}</span>
          </div>
        ))}
      </div>
      <p className="category-help-note">{t("control:genres.helpNote")}</p>
    </details>
  );
}

function CreateGenreDialog({ initial, busy, error, onCancel, onCreate }: {
  initial: string;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const { t } = useTranslation(["common", "control"]);
  const [name, setName] = useState(initial);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim()) void onCreate(name.trim()).catch(() => undefined);
  };
  return (
    <Modal title={t("control:genres.createTitle")} icon={<Drama size={20} />} busy={busy} onClose={onCancel} onSubmit={submit}>
      <Field label={t("control:genres.name")} value={name} onChange={setName} />
      {error && <MessageBox tone="error" title={t("control:genres.errorTitle")}>{error}</MessageBox>}
      <div className="modal-actions">
        <Button variant="secondary" disabled={busy} onClick={onCancel}>{t("control:ui.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={busy || !name.trim()}>
          {busy ? t("control:genres.creating") : t("control:genres.createGenre")}
        </Button>
      </div>
    </Modal>
  );
}

function EditGenreDialog({ genre, others, busy, error, change, onClose }: {
  genre: Genre;
  others: Genre[];
  busy: string;
  error: string;
  change: (key: string, path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation(["common", "control"]);
  const [name, setName] = useState(genre.name);
  const [keyword, setKeyword] = useState("");
  const [mergeInto, setMergeInto] = useState("");
  const [confirm, setConfirm] = useState<"merge" | "delete" | null>(null);
  const path = `/${encodeURIComponent(genre.id)}`;
  const working = busy !== "";
  const into = others.find((other) => other.id === mergeInto) ?? null;

  const addKeywords = async () => {
    const words = keyword.split(/[,\n]/).map((word) => word.trim()).filter(Boolean);
    for (const word of words) await change("keyword", `${path}/keywords`, "POST", { word });
    setKeyword("");
  };

  return (
    <>
      <Modal variant="panel" title={t("control:genres.editTitle")} subtitle={genre.name} icon={<Drama size={20} />} busy={working} onClose={onClose}>
        <div className="modal-tab-content genres-edit">
          {error && !confirm && <MessageBox tone="error" title={t("control:genres.errorTitle")}>{error}</MessageBox>}

          <form
            className="genres-inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim() && name.trim() !== genre.name) void change("rename", path, "PATCH", { name: name.trim() }).catch(() => undefined);
            }}
          >
            <Field label={t("control:genres.name")} value={name} onChange={setName} />
            <Button variant="primary" type="submit" disabled={working || !name.trim() || name.trim() === genre.name}>
              {busy === "rename" ? t("control:genres.saving") : t("control:genres.saveName")}
            </Button>
          </form>

          <section>
            <h3>{t("control:genres.keywordsTitle")}</h3>
            <p className="muted">{t("control:genres.keywordsHint")}</p>
            {genre.keywords.length === 0 ? (
              <p className="management-empty">{t("control:genres.keywordsNone")}</p>
            ) : (
              <ul className="genres-chips">
                {genre.keywords.map((word) => (
                  <li key={word} className="genres-chip">
                    <span>{word}</span>
                    <Button
                      variant="icon"
                      disabled={working}
                      aria-label={t("control:genres.removeKeywordAria", { word })}
                      title={t("control:genres.removeKeywordAria", { word })}
                      onClick={() => void change(`kw:${word}`, `${path}/keywords/remove`, "POST", { word }).catch(() => undefined)}
                    >
                      <X size={14} aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <form className="genres-inline-form" onSubmit={(event) => { event.preventDefault(); void addKeywords().catch(() => undefined); }}>
              <Field label={t("control:genres.addKeyword")} value={keyword} onChange={setKeyword} placeholder={t("control:genres.addKeywordPlaceholder")} required={false} />
              <Button variant="primary" type="submit" disabled={working || !keyword.trim()}>{t("control:ui.add")}</Button>
            </form>
          </section>

          {others.length > 0 && (
            <section>
              <h3>{t("control:genres.mergeTitle")}</h3>
              <div className="genres-inline-form">
                <SelectField
                  label={t("control:genres.mergeInto")}
                  value={mergeInto}
                  onChange={setMergeInto}
                  options={[{ value: "", label: t("control:genres.addToPlaceholder") }, ...others.map((other) => ({ value: other.id, label: other.name }))]}
                />
                <Button variant="secondary" disabled={working || !into} onClick={() => setConfirm("merge")}>
                  <GitMerge size={15} aria-hidden="true" /> {t("control:genres.merge")}
                </Button>
              </div>
            </section>
          )}

          <div className="modal-actions">
            <Button variant="text" danger disabled={working} onClick={() => setConfirm("delete")}>
              <Trash2 size={15} aria-hidden="true" /> {t("control:genres.deleteGenre")}
            </Button>
            <Button variant="secondary" disabled={working} onClick={onClose}>{t("common.close")}</Button>
          </div>
        </div>
      </Modal>

      {confirm === "merge" && into && (
        <ConfirmDialog
          title={t("control:genres.mergeConfirmTitle", { name: genre.name, into: into.name })}
          confirmLabel={t("control:genres.merge")}
          busyLabel={t("control:genres.merging")}
          confirmIcon={<GitMerge size={15} aria-hidden="true" />}
          busy={busy === "merge"}
          error={error}
          onConfirm={() => void change("merge", `${path}/merge`, "POST", { into: into.id }).then(onClose, () => undefined)}
          onCancel={() => setConfirm(null)}
        >
          {t("control:genres.mergeConfirmBody", { name: genre.name, into: into.name })}
        </ConfirmDialog>
      )}

      {confirm === "delete" && (
        <ConfirmDialog
          title={t("control:genres.deleteTitle", { name: genre.name })}
          confirmLabel={t("control:genres.deleteGenre")}
          busyLabel={t("control:genres.deleting")}
          confirmIcon={<Trash2 size={15} aria-hidden="true" />}
          danger
          busy={busy === "delete"}
          error={error}
          onConfirm={() => void change("delete", path, "DELETE").then(onClose, () => undefined)}
          onCancel={() => setConfirm(null)}
        >
          {t("control:genres.deleteBody", { count: genre.titles })}
        </ConfirmDialog>
      )}
    </>
  );
}
