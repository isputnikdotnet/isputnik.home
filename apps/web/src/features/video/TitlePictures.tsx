import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Image as ImageIcon, Upload, X } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { DEFAULT_COVERS } from "../audiobooks/covers";
import { VIDEO_API, type VideoKind, type VideoMovie, type VideoShow } from "./types";

// Pictures (the Edit dialog's tab): a title's poster — one of TMDB's, or the
// admin's own upload, which wins over a poster.jpg beside the files and TMDB's —
// and its backdrop. Each change is saved at once and the title answered as the
// family now sees it.

interface PictureChoice {
  path: string;
  preview: string;
  /** Null for a picture with no words on it. */
  language: string | null;
}

type Answer = { show?: VideoShow; movie?: VideoMovie };

export function TitlePictures({ kind, title, onChanged }: {
  kind: VideoKind;
  title: VideoShow | VideoMovie;
  onChanged: (title: VideoShow | VideoMovie) => void;
}) {
  return (
    <div className="video-pictures">
      <PosterChooser kind={kind} title={title} onChanged={onChanged} />
      {title.tmdbMatch?.state === "matched" && <BackdropChooser kind={kind} title={title} onChosen={onChanged} />}
    </div>
  );
}

function PosterChooser({ kind, title, onChanged }: { kind: VideoKind; title: VideoShow | VideoMovie; onChanged: (title: VideoShow | VideoMovie) => void }) {
  const { t } = useTranslation();
  const url = `${VIDEO_API}/admin/metadata/items/${encodeURIComponent(title.id)}`;
  const [list, setList] = useState<{ posters: PictureChoice[]; uploaded: boolean; choice: string | null; current: string | null; tmdb: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [uploaded, setUploaded] = useState<boolean | null>(null);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const answer = await api<NonNullable<typeof list>>(`${url}/posters`);
      setList(answer);
      setUploaded(answer.uploaded);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("video.edit.postersFailed"));
    } finally {
      setLoading(false);
    }
  };

  const changed = async (key: string, work: Promise<Answer>, nowUploaded: boolean | null) => {
    setSaving(key);
    setError("");
    try {
      const answer = await work;
      const updated = answer.show ?? answer.movie;
      if (updated) onChanged(updated);
      if (nowUploaded !== null) setUploaded(nowUploaded);
      if (list) await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("video.match.saveFailed"));
    } finally {
      setSaving(null);
    }
  };

  const upload = (file: File) => void changed("upload", api<Answer>(`${url}/poster/upload`, {
    method: "PUT",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file
  }), true);

  return (
    <section className="video-backdrops">
      <div className="video-backdrops-head">
        <h3>{t("video.edit.posterTitle")}</h3>
      </div>
      <div className="video-poster-now">
        <img src={title.poster ?? DEFAULT_COVERS[kind === "shows" ? "show" : "movie"]} alt="" />
        <div className="video-poster-actions">
          <p className="muted">{uploaded ? t("video.edit.posterUploaded") : t("video.edit.posterHint")}</p>
          <div className="video-poster-buttons">
            <label className={`secondary-button compact-button${saving ? " is-disabled" : ""}`}>
              <Upload size={15} aria-hidden="true" />
              <span>{saving === "upload" ? t("video.edit.uploading") : t("video.edit.upload")}</span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                disabled={saving !== null}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) upload(file);
                  event.currentTarget.value = "";
                }}
              />
            </label>
            {uploaded && (
              <Button variant="text" disabled={saving !== null} onClick={() => void changed("remove", api<Answer>(`${url}/poster/upload`, { method: "DELETE" }), false)}>
                <X size={15} aria-hidden="true" />
                {saving === "remove" ? t("video.match.saving") : t("video.edit.removeUpload")}
              </Button>
            )}
            {!list && title.tmdbMatch?.state === "matched" && (
              <Button variant="secondary" compact disabled={loading} onClick={() => void load()}>
                <ImageIcon size={16} aria-hidden="true" />
                {loading ? t("video.match.backdropsLoading") : t("video.edit.postersShow")}
              </Button>
            )}
            {list?.choice && (
              <Button variant="text" disabled={saving !== null} onClick={() => void changed("auto", api<Answer>(`${url}/poster`, { method: "PUT", body: JSON.stringify({ path: null }) }), null)}>
                {saving === "auto" ? t("video.match.saving") : t("video.edit.posterAutomatic")}
              </Button>
            )}
          </div>
        </div>
      </div>
      {error && <MessageBox tone="error" title={t("video.edit.failedTitle")}>{error}</MessageBox>}
      {list && list.posters.length === 0 && <p className="muted">{t("video.edit.postersNone")}</p>}
      {list && list.posters.length > 0 && (
        <ul className="video-posters-grid">
          {list.posters.map((poster) => {
            const current = poster.path === list.current;
            return (
              <li key={poster.path}>
                <Button
                  variant="bare"
                  className={`video-backdrop video-poster-choice${current ? " is-current" : ""}`}
                  disabled={saving !== null}
                  aria-pressed={current}
                  aria-label={poster.language ? t("video.edit.posterInLanguage", { language: poster.language.toUpperCase() }) : t("video.match.backdropNoText")}
                  onClick={() => void changed(poster.path, api<Answer>(`${url}/poster`, { method: "PUT", body: JSON.stringify({ path: poster.path }) }), null)}
                >
                  <img src={poster.preview} alt="" loading="lazy" />
                  {current && <Check size={18} aria-hidden="true" />}
                  {poster.language && <span className="video-backdrop-lang">{poster.language.toUpperCase()}</span>}
                  {saving === poster.path && <span className="video-backdrop-saving">{t("video.match.saving")}</span>}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// The backdrop behind a title (the banner, its page, a wide card): the engine
// takes TMDB's best-voted one with no words on it; when that is a poor picture
// the admin picks another of TMDB's here, or hands it back to the votes.
export function BackdropChooser({ kind, title, onChosen }: { kind: VideoKind; title: VideoShow | VideoMovie; onChosen: (title: VideoShow | VideoMovie) => void }) {
  const { t } = useTranslation();
  const [list, setList] = useState<{ backdrops: PictureChoice[]; current: string | null; chosen: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState("");
  const url = `${VIDEO_API}/admin/metadata/items/${encodeURIComponent(title.id)}`;

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setList(await api<{ backdrops: PictureChoice[]; current: string | null; chosen: boolean }>(`${url}/backdrops`));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("video.match.backdropsFailed"));
    } finally {
      setLoading(false);
    }
  };

  const choose = async (imagePath: string | null) => {
    setSaving(imagePath ?? "auto");
    setError("");
    try {
      const answer = await api<Answer>(`${url}/backdrop`, { method: "PUT", body: JSON.stringify({ path: imagePath }) });
      const updated = answer.show ?? answer.movie;
      if (updated) onChosen(updated);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("video.match.saveFailed"));
    } finally {
      setSaving(null);
    }
  };

  return (
    <section className="video-backdrops">
      <div className="video-backdrops-head">
        <h3>{t("video.match.backdropTitle")}</h3>
        {!list && (
          <Button variant="secondary" compact disabled={loading} onClick={() => void load()}>
            <ImageIcon size={16} aria-hidden="true" />
            {loading ? t("video.match.backdropsLoading") : t("video.match.backdropsShow")}
          </Button>
        )}
        {list?.chosen && (
          <Button variant="text" disabled={saving !== null} onClick={() => void choose(null)}>
            {saving === "auto" ? t("video.match.saving") : t("video.match.backdropAutomatic")}
          </Button>
        )}
      </div>
      <p className="muted">{t(kind === "shows" ? "video.match.backdropHintShow" : "video.match.backdropHintMovie")}</p>
      {error && <MessageBox tone="error" title={t("video.match.failedTitle")}>{error}</MessageBox>}
      {list && list.backdrops.length === 0 && <p className="muted">{t("video.match.backdropsNone")}</p>}
      {list && list.backdrops.length > 0 && (
        <ul className="video-backdrops-grid">
          {list.backdrops.map((backdrop) => {
            const current = backdrop.path === list.current;
            return (
              <li key={backdrop.path}>
                <Button
                  variant="bare"
                  className={`video-backdrop${current ? " is-current" : ""}`}
                  disabled={saving !== null}
                  aria-pressed={current}
                  aria-label={backdrop.language ? t("video.match.backdropWithText") : t("video.match.backdropNoText")}
                  title={current ? t("video.match.current") : undefined}
                  onClick={() => void choose(backdrop.path)}
                >
                  <img src={backdrop.preview} alt="" loading="lazy" />
                  {current && <Check size={18} aria-hidden="true" />}
                  {backdrop.language && <span className="video-backdrop-lang">{backdrop.language.toUpperCase()}</span>}
                  {saving === backdrop.path && <span className="video-backdrop-saving">{t("video.match.saving")}</span>}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
