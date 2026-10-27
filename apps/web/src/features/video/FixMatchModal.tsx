import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Check, Film, Search, Tv } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { Field } from "../../shared/Field";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { VIDEO_API, type VideoKind, type VideoMovie, type VideoShow, type VideoTmdbCandidate } from "./types";

// Fix match (admins): the engine matched a title to the wrong film or show on
// TMDB, or to none. Search TMDB by name and year, pick the right one; the engine
// keeps that choice through every rescan until it is handed back to the
// automatic match.
export function FixMatchModal({ kind, title, onClose, onMatched }: {
  kind: VideoKind;
  title: VideoShow | VideoMovie;
  onClose: () => void;
  onMatched: (title: VideoShow | VideoMovie) => void;
}) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState(title.title);
  const [year, setYear] = useState(title.year ? String(title.year) : "");
  const [results, setResults] = useState<VideoTmdbCandidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState("");
  const match = title.tmdbMatch ?? null;
  const KindIcon = kind === "shows" ? Tv : Film;

  const search = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setError("");
    const params = new URLSearchParams({ kind: kind === "shows" ? "tv" : "movie", q: query.trim(), language: (i18n.resolvedLanguage ?? "en").slice(0, 2) });
    if (/^\d{4}$/.test(year.trim())) params.set("year", year.trim());
    try {
      setResults((await api<{ results: VideoTmdbCandidate[] }>(`${VIDEO_API}/admin/metadata/search?${params}`)).results);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("video.match.searchFailed"));
    } finally {
      setSearching(false);
    }
  };

  const choose = async (tmdbId: string | null) => {
    setSaving(tmdbId ?? "auto");
    setError("");
    try {
      const answer = await api<{ show?: VideoShow; movie?: VideoMovie }>(`${VIDEO_API}/admin/metadata/items/${encodeURIComponent(title.id)}`, {
        method: "PUT",
        body: JSON.stringify({ tmdbId })
      });
      const updated = answer.show ?? answer.movie;
      if (updated) onMatched(updated);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("video.match.saveFailed"));
    } finally {
      setSaving(null);
    }
  };

  return (
    <Modal
      variant="panel"
      title={t("video.match.title")}
      subtitle={title.title}
      icon={<Search size={20} />}
      className="video-match-modal"
      busy={saving !== null}
      onClose={onClose}
    >
      <div className="modal-tab-content">
        <p className="muted">
          {match?.state === "matched" && match.id
            ? t(match.locked ? "video.match.nowFixed" : "video.match.nowAuto", { id: match.id })
            : match?.state === "error"
              ? t("video.match.nowError", { error: match.error ?? "" })
              : t("video.match.nowNone")}
        </p>

        <form className="video-match-search" onSubmit={(event) => void search(event)}>
          <Field label={t("video.match.query")} value={query} onChange={setQuery} />
          <Field label={t("video.match.year")} type="number" min={1880} max={2100} required={false} value={year} onChange={setYear} />
          <Button variant="primary" type="submit" disabled={searching || !query.trim()}>
            <Search size={16} aria-hidden="true" />
            {searching ? t("video.match.searching") : t("video.match.search")}
          </Button>
        </form>

        {error && <MessageBox tone="error" title={t("video.match.failedTitle")}>{error}</MessageBox>}

        {results && results.length === 0 && <p className="muted">{t("video.match.noResults")}</p>}
        {results && results.length > 0 && (
          <ul className="video-match-results">
            {results.map((result) => {
              const current = match?.id === result.tmdbId;
              return (
                <li key={result.tmdbId}>
                  <Button
                    variant="bare"
                    className={`video-match-result${current ? " is-current" : ""}`}
                    disabled={saving !== null}
                    onClick={() => void choose(result.tmdbId)}
                  >
                    <span className="video-match-poster" aria-hidden="true">
                      {result.poster ? <img src={result.poster} alt="" loading="lazy" /> : <KindIcon size={20} />}
                    </span>
                    <span className="video-match-copy">
                      <strong>
                        {result.title}
                        {result.year ? ` (${result.year})` : ""}
                        {current && <Check size={15} aria-label={t("video.match.current")} />}
                      </strong>
                      {result.originalTitle && result.originalTitle !== result.title && <small className="muted">{result.originalTitle}</small>}
                      {result.overview && <span className="video-match-overview">{result.overview}</span>}
                      {saving === result.tmdbId && <small>{t("video.match.saving")}</small>}
                    </span>
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        <div className="modal-actions">
          {match?.locked && (
            <Button variant="text" disabled={saving !== null} onClick={() => void choose(null)}>
              {saving === "auto" ? t("video.match.saving") : t("video.match.automatic")}
            </Button>
          )}
          <Button variant="secondary" disabled={saving !== null} onClick={onClose}>{t("common.close")}</Button>
        </div>
      </div>
    </Modal>
  );
}
