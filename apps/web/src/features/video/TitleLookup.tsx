import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Check, Film, Search, Tv } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { Field } from "../../shared/Field";
import { MessageBox } from "../../shared/MessageBox";
import { VIDEO_API, type VideoKind, type VideoMovie, type VideoShow, type VideoTmdbCandidate } from "./types";

// Lookup (the Edit dialog's tab): what Fix match was. Search TMDB by name and
// year — or by an IMDb or TMDB link, for a title its name doesn't find — pick
// the right title, and compare its words with the title's, field by field: the
// ticked ones go into the Details and Genres tabs, and the match itself is saved
// with them, by the dialog's one Save. A match chosen here is
// kept through every rescan until it is handed back to the automatic one.

export interface LookupDetails {
  tmdbId: string;
  kind: "movie" | "tv";
  title: string | null;
  originalTitle: string | null;
  year: number | null;
  plot: string | null;
  /** Through the admin's genre list. */
  genres: string[];
  poster: string | null;
}

export type LookupField = "title" | "originalTitle" | "year" | "plot" | "genres";

/** What a row of the comparison says the title has now. */
export interface LookupCurrent {
  title: string;
  originalTitle: string;
  year: string;
  plot: string;
  genres: string[];
}

export function TitleLookup({ kind, title, current, onUse, onAutomatic }: {
  kind: VideoKind;
  title: VideoShow | VideoMovie;
  current: LookupCurrent;
  /** The match chosen, and the fields ticked to take from it. */
  onUse: (details: LookupDetails, fields: LookupField[]) => void;
  onAutomatic: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState(title.title);
  const [year, setYear] = useState(title.year ? String(title.year) : "");
  const [results, setResults] = useState<VideoTmdbCandidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [details, setDetails] = useState<LookupDetails | null>(null);
  const [ticked, setTicked] = useState<Set<LookupField>>(new Set());
  const [error, setError] = useState("");
  const match = title.tmdbMatch ?? null;
  const ownKind = kind === "shows" ? "tv" : "movie";
  const language = (i18n.resolvedLanguage ?? "en").slice(0, 2);

  const search = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setError("");
    setDetails(null);
    const params = new URLSearchParams({ kind: ownKind, q: query.trim(), language });
    if (/^\d{4}$/.test(year.trim())) params.set("year", year.trim());
    try {
      setResults((await api<{ results: VideoTmdbCandidate[] }>(`${VIDEO_API}/admin/metadata/search?${params}`)).results);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("video.match.searchFailed"));
    } finally {
      setSearching(false);
    }
  };

  const open = async (result: VideoTmdbCandidate) => {
    const resultKind = result.kind ?? ownKind;
    setOpening(`${resultKind}-${result.tmdbId}`);
    setError("");
    try {
      const params = new URLSearchParams({ kind: resultKind, id: result.tmdbId, language });
      const found = await api<LookupDetails>(`${VIDEO_API}/admin/metadata/details?${params}`);
      setDetails(found);
      // Ticked to begin with: what the title has nothing for and TMDB does.
      const empty = new Set<LookupField>();
      if (!current.originalTitle && found.originalTitle) empty.add("originalTitle");
      if (!current.year && found.year) empty.add("year");
      if (!current.plot && found.plot) empty.add("plot");
      if (current.genres.length === 0 && found.genres.length > 0) empty.add("genres");
      setTicked(empty);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("video.edit.detailsFailed"));
    } finally {
      setOpening(null);
    }
  };

  if (details) {
    const rows: { field: LookupField; label: string; now: string; found: string }[] = [
      { field: "title", label: t("video.edit.fieldTitle"), now: current.title, found: details.title ?? "" },
      { field: "originalTitle", label: t("video.edit.fieldOriginalTitle"), now: current.originalTitle, found: details.originalTitle ?? "" },
      { field: "year", label: t("video.edit.fieldYear"), now: current.year, found: details.year ? String(details.year) : "" },
      { field: "plot", label: t("video.edit.fieldPlot"), now: current.plot, found: details.plot ?? "" },
      { field: "genres", label: t("video.edit.tabGenres"), now: current.genres.join(", "), found: details.genres.join(", ") }
    ];
    const toggle = (field: LookupField) => setTicked((now) => {
      const next = new Set(now);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
    return (
      <div className="video-lookup">
        <div className="video-lookup-head">
          {details.poster && <img src={details.poster} alt="" />}
          <div>
            <strong>{details.title}{details.year ? ` (${details.year})` : ""}</strong>
            <p className="muted">{t("video.edit.lookupCompareHint")}</p>
          </div>
        </div>
        <table className="video-lookup-compare">
          <thead>
            <tr>
              <th aria-label={t("video.edit.lookupTake")}></th>
              <th>{t("video.edit.lookupField")}</th>
              <th>{t("video.edit.lookupNow")}</th>
              <th>TMDB</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.field} className={row.now === row.found ? "is-same" : undefined}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={t("video.edit.lookupTakeField", { field: row.label })}
                    checked={ticked.has(row.field)}
                    disabled={!row.found || row.now === row.found}
                    onChange={() => toggle(row.field)}
                  />
                </td>
                <th scope="row">{row.label}</th>
                <td className="video-lookup-value">{row.now || "—"}</td>
                <td className="video-lookup-value">{row.found || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="modal-actions">
          <Button variant="secondary" onClick={() => setDetails(null)}>{t("video.edit.lookupBack")}</Button>
          <Button variant="primary" onClick={() => onUse(details, [...ticked])}>
            <Check size={15} aria-hidden="true" />
            {t("video.edit.lookupUse")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="video-lookup">
      <p className="muted">
        {match?.state === "matched" && match.id
          ? t(match.locked ? "video.match.nowFixed" : "video.match.nowAuto", { id: match.id })
          : match?.state === "error"
            ? t("video.match.nowError", { error: match.error ?? "" })
            : t("video.match.nowNone")}
        {match?.locked && (
          <>
            {" "}
            <Button variant="text" onClick={onAutomatic}>{t("video.match.automatic")}</Button>
          </>
        )}
      </p>

      <form className="video-match-search" onSubmit={(event) => void search(event)}>
        <Field label={t("video.match.query")} value={query} onChange={setQuery} />
        <Field label={t("video.match.year")} type="number" min={1880} max={2100} required={false} value={year} onChange={setYear} />
        <Button variant="primary" type="submit" disabled={searching || !query.trim()}>
          <Search size={16} aria-hidden="true" />
          {searching ? t("video.match.searching") : t("video.match.search")}
        </Button>
      </form>

      <p className="muted video-match-hint">{t("video.match.queryHint")}</p>

      {error && <MessageBox tone="error" title={t("video.match.failedTitle")}>{error}</MessageBox>}

      {results && results.length === 0 && <p className="muted">{t("video.match.noResults")}</p>}
      {results && results.length > 0 && (
        <ul className="video-match-results">
          {results.map((result) => {
            // TMDB counts films and shows apart, so an id names a title only with its kind.
            const resultKind = result.kind ?? ownKind;
            const isCurrent = match?.id === result.tmdbId && (match.kind ?? ownKind) === resultKind;
            const KindIcon = resultKind === "tv" ? Tv : Film;
            const key = `${resultKind}-${result.tmdbId}`;
            return (
              <li key={key}>
                <Button
                  variant="bare"
                  className={`video-match-result${isCurrent ? " is-current" : ""}`}
                  disabled={opening !== null}
                  onClick={() => void open(result)}
                >
                  <span className="video-match-poster" aria-hidden="true">
                    {result.poster ? <img src={result.poster} alt="" loading="lazy" /> : <KindIcon size={20} />}
                  </span>
                  <span className="video-match-copy">
                    <strong>
                      {result.title}
                      {result.year ? ` (${result.year})` : ""}
                      {isCurrent && <Check size={15} aria-label={t("video.match.current")} />}
                    </strong>
                    {resultKind !== ownKind && (
                      <small className="video-match-kind">
                        <KindIcon size={13} aria-hidden="true" />
                        {t(resultKind === "tv" ? "video.match.kindTv" : "video.match.kindMovie")}
                      </small>
                    )}
                    {result.originalTitle && result.originalTitle !== result.title && <small className="muted">{result.originalTitle}</small>}
                    {result.overview && <span className="video-match-overview">{result.overview}</span>}
                    {opening === key && <small>{t("video.edit.loading")}</small>}
                  </span>
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
