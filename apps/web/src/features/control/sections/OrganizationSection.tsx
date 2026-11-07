import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, Drama, Eraser, RefreshCw, Shapes, Tag, Tags } from "lucide-react";
import { api } from "../../../api";
import { controlHref, followRoute, type ControlSection } from "../../../router";
import { Button } from "../../../shared/Button";
import { MessageBox } from "../../../shared/MessageBox";
import { formatNumber } from "../../../shared/dates";
import { ControlSectionHead } from "../ControlSectionHead";
import { isRunning, useAppsStatus } from "./AppsSection";

// Library › Organization (4.73): how content is labelled and grouped. Book
// categories, Tags and Video genres used to be three Library tabs that read as
// equals of Libraries and Storage, though each applies to only some content. Here
// each is a card that says what it applies to, shows its live numbers and offers
// the action people most often come for; its editor is a page under this tab
// (nav.ts `pages`), reached from the card, from search, or from a library's
// Manage page.

interface CategoryRow { id: string; bookCount: number }
interface TagRow { id: string; libraryItemCount: number; otherCount: number }
interface GenresOverview { genres: unknown[]; words: { state: string }[] }

export function OrganizationSection() {
  const { t } = useTranslation(["common", "control"]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  return (
    <>
      <ControlSectionHead section="organization" icon={<Tags size={30} />} description={t("control:organization.description")} />
      {error && <MessageBox tone="error" title={t("control:organization.errorTitle")}>{error}</MessageBox>}
      {notice && <MessageBox tone="success" title={t("control:organization.doneTitle")}>{notice}</MessageBox>}
      <div className="organization-grid">
        <CategoriesCard onError={setError} onNotice={setNotice} />
        <TagsCard onError={setError} onNotice={setNotice} />
        <GenresCard />
      </div>
      <p className="organization-footnote muted">{t("control:organization.sharedNote")}</p>
    </>
  );
}

interface CardProps {
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}

function OrganizationCard({
  icon,
  title,
  body,
  appliesTo,
  stats,
  editor,
  editorLabel,
  extra
}: {
  icon: ReactNode;
  title: string;
  body: string;
  appliesTo: string;
  stats: ReactNode;
  editor: ControlSection;
  editorLabel: string;
  extra?: ReactNode;
}) {
  const { t } = useTranslation(["control"]);
  const href = controlHref(editor);
  return (
    <section className="organization-card">
      <div className="organization-card-top">
        <span className="organization-card-icon" aria-hidden="true">{icon}</span>
        <div>
          <h2>{title}</h2>
          <p>{body}</p>
        </div>
      </div>
      <div className="organization-applies">
        <small>{t("control:organization.appliesTo")}</small>
        {appliesTo}
      </div>
      <div className="organization-stats">{stats}</div>
      <div className="organization-actions">
        <a className="secondary-button compact-button" href={href} onClick={(event) => followRoute(event, href)}>
          {editorLabel}
          <ArrowRight size={15} aria-hidden="true" />
        </a>
        {extra}
      </div>
    </section>
  );
}

function CategoriesCard({ onError, onNotice }: CardProps) {
  const { t } = useTranslation(["common", "control"]);
  const [rows, setRows] = useState<CategoryRow[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ categories: CategoryRow[] }>("/api/library/manage/categories")
      .then((payload) => setRows(payload.categories))
      .catch((err) => onError(err instanceof Error ? err.message : t("control:organization.loadFailed")));
  }, [onError, t]);

  const rematch = async () => {
    setBusy(true);
    onError("");
    try {
      const { changed } = await api<{ changed: number }>("/api/library/manage/rematch", { method: "POST", body: "{}" });
      onNotice(t("control:organization.rematched", { count: changed }));
      const payload = await api<{ categories: CategoryRow[] }>("/api/library/manage/categories");
      setRows(payload.categories);
    } catch (err) {
      onError(err instanceof Error ? err.message : t("control:organization.rematchFailed"));
    } finally {
      setBusy(false);
    }
  };

  const sorted = rows?.reduce((sum, row) => sum + row.bookCount, 0) ?? 0;
  return (
    <OrganizationCard
      icon={<Shapes size={20} />}
      title={t("control:nav.tabs.categories")}
      body={t("control:organization.categoriesBody")}
      appliesTo={t("control:organization.categoriesAppliesTo")}
      stats={rows === null ? <span>{t("control:ui.loading")}</span> : (
        <>
          <span>{t("control:organization.categoryCount", { count: rows.length, formatted: formatNumber(rows.length) })}</span>
          <span>{t("control:organization.booksSorted", { count: sorted, formatted: formatNumber(sorted) })}</span>
        </>
      )}
      editor="categories"
      editorLabel={t("control:organization.manageCategories")}
      extra={
        <Button variant="text" compact disabled={busy} onClick={() => void rematch()}>
          <RefreshCw size={14} aria-hidden="true" />
          {busy ? t("control:organization.rematching") : t("control:organization.rematch")}
        </Button>
      }
    />
  );
}

function TagsCard({ onError, onNotice }: CardProps) {
  const { t } = useTranslation(["common", "control"]);
  const [rows, setRows] = useState<TagRow[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const payload = await api<{ tags: TagRow[] }>("/api/library/manage/tags");
    setRows(payload.tags);
  }, []);

  useEffect(() => {
    load().catch((err) => onError(err instanceof Error ? err.message : t("control:organization.loadFailed")));
  }, [load, onError, t]);

  // Unused means used nowhere: the same rule as the Tags page and the server's prune.
  const unused = rows?.filter((row) => row.libraryItemCount + row.otherCount === 0).length ?? 0;

  const prune = async () => {
    setBusy(true);
    onError("");
    try {
      const payload = await api<{ pruned: number }>("/api/library/manage/tags/prune", { method: "POST", body: "{}" });
      onNotice(t("control:organization.pruned", { count: payload.pruned }));
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : t("control:organization.pruneFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <OrganizationCard
      icon={<Tag size={20} />}
      title={t("control:nav.tabs.tags")}
      body={t("control:organization.tagsBody")}
      appliesTo={t("control:organization.tagsAppliesTo")}
      stats={rows === null ? <span>{t("control:ui.loading")}</span> : (
        <>
          <span>{t("control:organization.tagCount", { count: rows.length, formatted: formatNumber(rows.length) })}</span>
          {unused > 0 && <span className="is-warning">{t("control:organization.unusedCount", { count: unused })}</span>}
        </>
      )}
      editor="tags"
      editorLabel={t("control:organization.manageTags")}
      extra={unused > 0 && (
        <Button variant="text" compact disabled={busy} onClick={() => void prune()}>
          <Eraser size={14} aria-hidden="true" />
          {busy ? t("control:organization.removing") : t("control:organization.removeUnused", { count: unused })}
        </Button>
      )}
    />
  );
}

function GenresCard() {
  const { t } = useTranslation(["common", "control"]);
  const { apps } = useAppsStatus();
  const video = apps?.find((app) => app.id === "video") ?? null;
  const running = video ? isRunning(video) : false;
  const [overview, setOverview] = useState<GenresOverview | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!video || !running) return;
    api<GenresOverview>(`${video.prefix}/api/admin/genres`)
      .then((payload) => { setOverview(payload); setFailed(false); })
      .catch(() => setFailed(true));
  }, [video, running]);

  const unsorted = overview?.words.filter((word) => word.state === "unsorted").length ?? 0;
  let stats: ReactNode;
  if (!apps) stats = <span>{t("control:ui.loading")}</span>;
  else if (!video?.configured) stats = <span>{t("control:organization.videoNotSetUp")}</span>;
  else if (!running || failed) stats = <span className="is-warning">{t("control:organization.videoDown")}</span>;
  else if (!overview) stats = <span>{t("control:ui.loading")}</span>;
  else stats = (
    <>
      <span>{t("control:organization.genreCount", { count: overview.genres.length, formatted: formatNumber(overview.genres.length) })}</span>
      {unsorted > 0 && <span className="is-warning">{t("control:organization.unsortedWords", { count: unsorted })}</span>}
    </>
  );

  return (
    <OrganizationCard
      icon={<Drama size={20} />}
      title={t("control:nav.tabs.genres")}
      body={t("control:organization.genresBody")}
      appliesTo={t("control:organization.genresAppliesTo")}
      stats={stats}
      editor="genres"
      editorLabel={t("control:organization.manageGenres")}
    />
  );
}
