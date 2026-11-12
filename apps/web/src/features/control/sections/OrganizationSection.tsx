import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, Copy, Eraser, ImageOff, RefreshCw, Shapes, Tag, Tags } from "lucide-react";
import { api } from "../../../api";
import { controlHrefFrom, followRoute, type ControlSection } from "../../../router";
import { Button } from "../../../shared/Button";
import { MessageBox } from "../../../shared/MessageBox";
import { formatNumber } from "../../../shared/dates";
import { ControlSectionHead } from "../ControlSectionHead";
import { appLabel } from "../nav";

// An application's Organize tab (control panel v2, docs/control-panel-v2-plan.md):
// its organization and cleanup tools as described destinations — never another
// row of tabs. Each card says what it applies to, shows its live numbers and
// offers the action people most often come for; its editor is a page under this
// tab (nav.ts `pages`) or, for a shared one (Tags, Book categories), the one
// shared editor opened with ?from=<app>. Library › Organization (4.73) held the
// shared editors before the workspaces did. Tools go here only when they exist.

interface CategoryRow { id: string; bookCount: number }
interface TagRow { id: string; libraryItemCount: number; otherCount: number }

type OrganizeApp = "gallery" | "ebooks" | "audiobooks";
const ORGANIZE_SECTION: Record<OrganizeApp, ControlSection> = {
  gallery: "galleryOrganize",
  ebooks: "ebooksOrganize",
  audiobooks: "audiobooksOrganize"
};

export function AppOrganizeSection({ app }: { app: OrganizeApp }) {
  const { t } = useTranslation(["common", "control"]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  return (
    <>
      <ControlSectionHead section={ORGANIZE_SECTION[app]} icon={<Tags size={30} />} description={t("control:organization.appDescription", { app: appLabel(app) })} />
      {error && <MessageBox tone="error" title={t("control:organization.errorTitle")}>{error}</MessageBox>}
      {notice && <MessageBox tone="success" title={t("control:organization.doneTitle")}>{notice}</MessageBox>}
      <div className="organization-grid">
        {app === "gallery" ? (
          <>
            <TagsCard from={app} onError={setError} onNotice={setNotice} />
            <ToolCard editor="duplicateCleanup" icon={<Copy size={20} />} body={t("control:organization.duplicatesBody")} editorLabel={t("control:organization.openDuplicates")} />
            <ToolCard editor="missingPhotos" icon={<ImageOff size={20} />} body={t("control:organization.missingBody")} editorLabel={t("control:organization.openMissing")} />
          </>
        ) : (
          <>
            <CategoriesCard from={app} onError={setError} onNotice={setNotice} />
            <TagsCard from={app} onError={setError} onNotice={setNotice} />
          </>
        )}
      </div>
      <p className="organization-footnote muted">{t("control:organization.sharedNote")}</p>
    </>
  );
}

interface CardProps {
  /** The workspace the shared editor is opened from. */
  from: OrganizeApp;
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
  from,
  editorLabel,
  extra
}: {
  icon: ReactNode;
  title: string;
  body: string;
  appliesTo?: string;
  stats?: ReactNode;
  editor: ControlSection;
  /** For a shared editor: the workspace it is opened from (?from=). */
  from?: OrganizeApp;
  editorLabel: string;
  extra?: ReactNode;
}) {
  const { t } = useTranslation(["control"]);
  const href = controlHrefFrom(editor, from);
  return (
    <section className="organization-card">
      <div className="organization-card-top">
        <span className="organization-card-icon" aria-hidden="true">{icon}</span>
        <div>
          <h2>{title}</h2>
          <p>{body}</p>
        </div>
      </div>
      {appliesTo && (
        <div className="organization-applies">
          <small>{t("control:organization.appliesTo")}</small>
          {appliesTo}
        </div>
      )}
      {stats && <div className="organization-stats">{stats}</div>}
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

function CategoriesCard({ from, onError, onNotice }: CardProps) {
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
      from={from}
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

function TagsCard({ from, onError, onNotice }: CardProps) {
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
      from={from}
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

// A tool that is a page of this tab (Duplicate cleanup, Missing photos): its own
// name, what it does, and the way in.
function ToolCard({ editor, icon, body, editorLabel }: { editor: ControlSection; icon: ReactNode; body: string; editorLabel: string }) {
  const { t } = useTranslation(["control"]);
  return <OrganizationCard icon={icon} title={t(`control:nav.tabs.${editor as "duplicateCleanup" | "missingPhotos"}`)} body={body} editor={editor} editorLabel={editorLabel} />;
}
