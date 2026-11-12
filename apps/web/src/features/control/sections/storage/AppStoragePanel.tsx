// The Storage page's App storage block — docs/system-data-plan.md, phase 3.
//
// One switch for four parts that always go together: the Photo Inbox, App files,
// Renders and Map data. Off, the block asks where App storage will live (in system
// data, or a custom folder); on, it shows the folder with Change. Under it the four
// parts are listed, not switched: where each is, what it holds, and — for a part
// left outside App storage — Move in. Every change is confirmed with the exact folder
// first, and a Storage page and the setup guide show this same block. Drawn as
// grouped rows (control panel v2): the switch and the folder, then the four parts,
// each a row with its own actions as rows under it.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Clapperboard, FolderHeart, HardDrive, Inbox, Map as MapIcon } from "lucide-react";
import { api } from "../../../../api";
import { controlHref } from "../../../../router";
import { Button } from "../../../../shared/Button";
import { ConfirmDialog } from "../../../../shared/ConfirmDialog";
import { Field } from "../../../../shared/Field";
import { ActionRow, CheckRow, FieldRow, InputRow, NavRow, ToggleRow } from "../../../../shared/GroupedList";
import { InfoHint } from "../../../../shared/InfoHint";
import { MessageBox } from "../../../../shared/MessageBox";
import { Modal } from "../../../../shared/Modal";
import { isLowSpace, SpaceMeter, useDiskSpace, type DiskSpace } from "./SpaceMeter";
import { InboxReviewersModal } from "./InboxReviewersModal";
import { InboxScanningModal } from "./InboxScanningModal";
// The panel shares system data's stylesheet: the same block shape (docs/css-map.md).
import "../../../../styles/system-data.css";

type Part = "inbox" | "house" | "renders" | "maps";
type Where = "system" | "custom";

interface StorageMove {
  running: boolean;
  done: number;
  pending: number;
  failed: { name: string; title?: string; error: string }[];
}

interface PartView {
  part: Part;
  folder: string | null;
  inside: boolean;
  library: { id: string; name: string } | null;
  counts: { waiting?: number; files?: number; tracks?: number; reviewers?: number; unowned?: number };
  move: StorageMove;
  renameTo: string | null;
}

export interface AppStorageView {
  enabled: boolean;
  where: Where;
  customPath: string | null;
  folder: string | null;
  systemFolder: string | null;
  systemDataSet: boolean;
  space: DiskSpace | null;
  parts: PartView[];
  moving: boolean;
  /** Why it would not switch off right now; null when it would. */
  offRefusal: string | null;
}

type Pending =
  | { kind: "on"; where: Where; path: string | null; folder: string }
  | { kind: "off" }
  | { kind: "change"; where: Where; path: string | null; folder: string }
  | { kind: "moveIn"; part: PartView }
  | { kind: "rename"; part: PartView };

const PARTS: Part[] = ["inbox", "house", "renders", "maps"];

export function AppStoragePanel({ refreshKey = 0, onChanged }: {
  /** Bumped by the page's Refresh button. */
  refreshKey?: number;
  /** Told after a change, so a page can re-read what depends on it. */
  onChanged?: (view: AppStorageView) => void;
}) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [view, setView] = useState<AppStorageView | null>(null);
  const [error, setError] = useState("");
  const [where, setWhere] = useState<Where>("system");
  const [customPath, setCustomPath] = useState("");
  const [changing, setChanging] = useState<{ where: Where; path: string } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [moveBusy, setMoveBusy] = useState(false);
  const [reviewersOpen, setReviewersOpen] = useState(false);
  const [scanningFor, setScanningFor] = useState<string | null>(null);

  const typedFolder = view && !view.enabled ? (where === "system" ? view.systemFolder ?? "" : customPath) : "";
  const typedSpace = useDiskSpace(typedFolder);
  const changeSpace = useDiskSpace(changing ? (changing.where === "system" ? view?.systemFolder ?? "" : changing.path) : "");

  const load = useCallback(async () => {
    const payload = await api<AppStorageView>("/api/storage/app-storage");
    setView(payload);
    return payload;
  }, []);

  useEffect(() => {
    load()
      .then((payload) => {
        setWhere(payload.where);
        setCustomPath(payload.customPath ?? "");
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("controlAdmin:appStorage.loadFailed")));
  }, [load, refreshKey, t]);

  const anyMoving = Boolean(view?.parts.some((entry) => entry.move.running));
  useEffect(() => {
    if (!anyMoving) return;
    const timer = setInterval(() => { load().catch(() => { /* next tick */ }); }, 2000);
    return () => clearInterval(timer);
  }, [anyMoving, load]);

  if (!view) {
    return error ? <MessageBox tone="error" title={t("controlAdmin:appStorage.loadFailed")}>{error}</MessageBox> : null;
  }

  const partName: Record<Part, string> = {
    inbox: t("controlAdmin:storage.roomInbox"),
    house: t("controlAdmin:storage.roomHouse"),
    renders: t("controlAdmin:storage.roomRenders"),
    maps: t("controlAdmin:storage.roomMaps")
  };

  const run = async (action: () => Promise<AppStorageView>) => {
    setSaving(true);
    setSaveError("");
    try {
      const payload = await action();
      setPending(null);
      setChanging(null);
      // The page's reading carries offRefusal; a change's answer does not, so read again.
      const fresh = await load().catch(() => ({ ...payload, offRefusal: view.offRefusal }));
      onChanged?.(fresh);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("controlAdmin:appStorage.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const confirm = () => {
    if (!pending) return;
    const post = (url: string, body?: object) => api<AppStorageView>(url, { method: "POST", body: JSON.stringify(body ?? {}) });
    switch (pending.kind) {
      case "on": return void run(() => post("/api/storage/app-storage/on", { where: pending.where, path: pending.path }));
      case "off": return void run(() => post("/api/storage/app-storage/off"));
      case "change": return void run(() => api<AppStorageView>("/api/storage/app-storage", { method: "PUT", body: JSON.stringify({ where: pending.where, path: pending.path }) }));
      case "moveIn": return void run(() => post(`/api/storage/app-storage/parts/${pending.part.part}/move-in`));
      case "rename": return void run(() => post("/api/storage/app-storage/parts/house/rename"));
    }
  };

  const moveAction = async (method: "POST" | "DELETE", part: Part) => {
    setMoveBusy(true);
    try {
      await api(`/api/storage/app-storage/parts/${part}/move`, { method });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:appStorage.loadFailed"));
    } finally {
      setMoveBusy(false);
    }
  };

  const askOn = () => {
    setSaveError("");
    const folder = where === "system" ? view.systemFolder : customPath.trim();
    if (!folder) {
      setError(t(where === "system" ? "controlAdmin:appStorage.needsSystemData" : "controlAdmin:appStorage.needsFolder"));
      return;
    }
    setError("");
    setPending({ kind: "on", where, path: where === "custom" ? customPath.trim() : null, folder });
  };

  const pendingCopy = (): { title: string; body: React.ReactNode; label: string; danger?: boolean; blocked?: string | null } | null => {
    if (!pending) return null;
    switch (pending.kind) {
      case "on":
        return { title: t("controlAdmin:appStorage.confirmOnTitle", { path: pending.folder }), body: t("controlAdmin:appStorage.confirmOnBody"), label: t("controlAdmin:appStorage.confirmOnLabel") };
      case "off":
        return {
          title: t("controlAdmin:appStorage.confirmOffTitle"),
          body: t("controlAdmin:appStorage.confirmOffBody"),
          label: t("controlAdmin:appStorage.confirmOffLabel"),
          danger: true,
          blocked: view.offRefusal
        };
      case "change":
        return { title: t("controlAdmin:appStorage.confirmChangeTitle", { path: pending.folder }), body: t("controlAdmin:appStorage.confirmChangeBody"), label: t("controlAdmin:appStorage.confirmChangeLabel") };
      case "moveIn":
        return pending.part.library || pending.part.part === "renders" || pending.part.part === "maps"
          ? { title: t("controlAdmin:appStorage.confirmMoveInTitle", { name: partName[pending.part.part], path: view.folder ?? "" }), body: t("controlAdmin:appStorage.confirmMoveInBody"), label: t("controlAdmin:appStorage.moveIn") }
          : { title: t("controlAdmin:appStorage.confirmMakeTitle", { name: partName[pending.part.part], path: view.folder ?? "" }), body: t("controlAdmin:appStorage.confirmMakeBody"), label: t("controlAdmin:appStorage.make") };
      case "rename":
        return {
          title: t("controlAdmin:storage.confirmRenameTitle", { name: pending.part.renameTo?.split(/[\\/]/).pop() ?? "" }),
          body: t("controlAdmin:storage.confirmRenameBody", { from: pending.part.folder ?? "", to: pending.part.renameTo ?? "", library: pending.part.library?.name ?? "" }),
          label: t("controlAdmin:storage.confirmRenameLabel")
        };
    }
  };

  const usingText = (entry: PartView): string => {
    if (!view.enabled) return "";
    if (entry.part === "inbox") {
      if (!entry.library) return "";
      const waiting = t("controlAdmin:storage.waiting", { count: entry.counts.waiting ?? 0 });
      const reviewers = entry.counts.reviewers
        ? t("controlAdmin:appStorage.reviewers.count", { count: entry.counts.reviewers })
        : t("controlAdmin:appStorage.reviewers.adminsOnly");
      return `${waiting} · ${reviewers}`;
    }
    if (entry.part === "house") return entry.library ? t("controlAdmin:appStorage.files", { count: entry.counts.files ?? 0 }) : "";
    if (entry.part === "renders" && (entry.counts.tracks ?? 0) > 0) return t("controlAdmin:storage.tracks", { count: entry.counts.tracks ?? 0 });
    return "";
  };

  const copy = pendingCopy();

  const partIcon: Record<Part, React.ReactNode> = {
    inbox: <Inbox size={17} />,
    house: <FolderHeart size={17} />,
    renders: <Clapperboard size={17} />,
    maps: <MapIcon size={17} />
  };
  const toggle = (on: boolean) => {
    setSaveError("");
    if (on) askOn();
    else setPending({ kind: "off" });
  };

  return (
    <section id="app-storage" className="storage-rows">
      <h3 className="grouped-list-title storage-rows-title">
        <span>{t("controlAdmin:appStorage.title")}</span>
        <span className="count-badge">{view.enabled ? t("controlAdmin:appStorage.on") : t("controlAdmin:appStorage.optional")}</span>
        <InfoHint label={t("controlAdmin:appStorage.infoLabel")}>
          <strong>{t("controlAdmin:appStorage.infoWhatTitle")}</strong>
          <span>{t("controlAdmin:appStorage.infoWhat")}</span>
          <strong>{t("controlAdmin:appStorage.infoGrowthTitle")}</strong>
          <span>{t("controlAdmin:appStorage.infoGrowth")}</span>
        </InfoHint>
      </h3>

      <div className="grouped-list-rows">
        <ToggleRow
          label={t("controlAdmin:appStorage.switchAria")}
          checked={view.enabled}
          disabled={saving || view.moving || (!view.enabled && !view.systemDataSet)}
          onChange={toggle}
        />
        {view.enabled ? (
          // The folder itself: tapping it is Change.
          <NavRow
            icon={<HardDrive size={17} />}
            iconTone={isLowSpace(view.space) ? "warn" : "ok"}
            label={<code className="storage-row-folder">{view.folder}</code>}
            sub={<SpaceMeter space={view.space} />}
            value={t("controlAdmin:appStorage.change")}
            disabled={view.moving}
            onClick={() => { setSaveError(""); setChanging({ where: view.where, path: view.customPath ?? "" }); }}
          />
        ) : (
          // Off: where it will live once switched on.
          <>
            <CheckRow
              label={t("controlAdmin:appStorage.whereSystem")}
              sub={view.systemFolder ? t("controlAdmin:appStorage.whereSystemHint", { path: view.systemFolder }) : t("controlAdmin:appStorage.needsSystemData")}
              checked={where === "system"}
              disabled={!view.systemDataSet}
              onSelect={() => setWhere("system")}
            />
            <CheckRow
              label={t("controlAdmin:appStorage.whereCustom")}
              sub={t("controlAdmin:appStorage.whereCustomHint")}
              checked={where === "custom"}
              onSelect={() => setWhere("custom")}
            />
            {where === "custom" && (
              <InputRow label={t("controlAdmin:appStorage.folderLabel")} value={customPath} onChange={setCustomPath} wide />
            )}
            {typedSpace && <FieldRow><SpaceMeter space={typedSpace} /></FieldRow>}
          </>
        )}
      </div>
      <p className="grouped-list-note">
        {view.moving
          ? t("controlAdmin:appStorage.movingTitle")
          : view.enabled && view.where === "system" ? t("controlAdmin:appStorage.sharesDisk") : t("controlAdmin:appStorage.desc")}
      </p>

      {error && <MessageBox tone="error" title={t("controlAdmin:appStorage.saveFailed")}>{error}</MessageBox>}
      {!view.systemDataSet && !view.enabled && (
        <MessageBox tone="info" title={t("controlAdmin:appStorage.needsSystemDataTitle")}>{t("controlAdmin:appStorage.needsSystemData")}</MessageBox>
      )}
      {isLowSpace(view.enabled ? view.space : typedSpace) && (
        <MessageBox tone="warning" title={t("controlAdmin:appStorage.lowTitle")}>
          {view.enabled ? t("controlAdmin:appStorage.lowBodyOn") : t("controlAdmin:appStorage.lowBody")}
        </MessageBox>
      )}

      {/* Its four parts, listed rather than switched: where each is, what it holds,
          and what can be done with it. */}
      <h3 className="grouped-list-title">{view.enabled ? t("controlAdmin:appStorage.insideSummary") : t("controlAdmin:appStorage.insideSummaryOff")}</h3>
      <div className={`grouped-list-rows${view.enabled ? "" : " is-off"}`}>
        {PARTS.map((name) => view.parts.find((entry) => entry.part === name)).filter((entry): entry is PartView => Boolean(entry)).map((entry) => {
          const outside = view.enabled && !entry.inside;
          const using = usingText(entry);
          const canMove = entry.library || entry.part === "renders" || entry.part === "maps";
          const actions = view.enabled && (
            (outside && !entry.move.running) || (entry.renameTo && !entry.move.running) || (entry.part === "inbox" && entry.library)
          );
          return (
            <div key={entry.part} className="storage-part">
              <div className="grouped-row storage-part-row">
                <span className={`grouped-row-icon${outside ? " is-warn" : view.enabled ? "" : " is-muted"}`} aria-hidden="true">{partIcon[entry.part]}</span>
                <span className="grouped-row-label">
                  <strong className="storage-part-name">
                    {partName[entry.part]}
                    <InfoHint label={t("controlAdmin:appStorage.aboutPart", { name: partName[entry.part] })}>
                      <strong>{partName[entry.part]}</strong>
                      <span>{t(`controlAdmin:appStorage.about.${entry.part}`)}</span>
                      <span><strong>{t("controlAdmin:appStorage.spaceLabel")}</strong> {t(`controlAdmin:appStorage.space.${entry.part}`)}</span>
                      <span><strong>{t("controlAdmin:appStorage.offLabel")}</strong> {t(`controlAdmin:appStorage.off.${entry.part}`)}</span>
                    </InfoHint>
                  </strong>
                  <small>
                    {t(`controlAdmin:appStorage.hint.${entry.part}`)}
                    <span className="storage-row-path">
                      {entry.folder ? <code>{entry.folder}</code> : t("controlAdmin:appStorage.insideWhenOn")}
                    </span>
                  </small>
                </span>
                {using && <span className="grouped-row-value">{using}</span>}
              </div>
              {entry.part === "house" && (entry.counts.unowned ?? 0) > 0 && (
                <FieldRow><div className="system-data-note">{t("controlAdmin:appStorage.unowned", { count: entry.counts.unowned ?? 0 })}</div></FieldRow>
              )}
              {outside && (
                <FieldRow><div className="system-data-note">{canMove ? t("controlAdmin:appStorage.outside") : t("controlAdmin:appStorage.missing")}</div></FieldRow>
              )}
              {entry.move.running && (
                <FieldRow>
                  <div className="app-storage-move">
                    <span>{t("controlAdmin:appStorage.moving", { moved: entry.move.done, total: entry.move.done + entry.move.pending })}</span>
                    <Button variant="text" compact disabled={moveBusy} onClick={() => void moveAction("DELETE", entry.part)}>
                      {t("controlAdmin:storage.moveCancel")}
                    </Button>
                  </div>
                </FieldRow>
              )}
              {!entry.move.running && entry.move.failed.length > 0 && (
                <FieldRow>
                  <div className="app-storage-move needs-attention">
                    <span title={entry.move.failed.map((f) => `${f.title ?? f.name}: ${f.error}`).join("\n")}>
                      {t("controlAdmin:appStorage.moveFailed", { count: entry.move.failed.length })}
                    </span>
                    <Button variant="text" compact disabled={moveBusy} onClick={() => void moveAction("POST", entry.part)}>
                      {t("controlAdmin:storage.moveRetry")}
                    </Button>
                  </div>
                </FieldRow>
              )}
              {/* A part's own actions, each a row of its own like a phone's
                  Settings: Move in (or Make it), Rename folder, and the Inbox's
                  reviewers and scanning (it is not on the Libraries page). */}
              {actions && (
                <>
                  {outside && !entry.move.running && (
                    <ActionRow
                      label={canMove ? t("controlAdmin:appStorage.moveIn") : t("controlAdmin:appStorage.make")}
                      disabled={view.moving}
                      onClick={() => { setSaveError(""); setPending({ kind: "moveIn", part: entry }); }}
                    />
                  )}
                  {entry.renameTo && !entry.move.running && (
                    <ActionRow label={t("controlAdmin:storage.renameFolder")} onClick={() => { setSaveError(""); setPending({ kind: "rename", part: entry }); }} />
                  )}
                  {entry.part === "inbox" && entry.library && (
                    <>
                      <NavRow label={t("controlAdmin:appStorage.reviewers.button")} onClick={() => setReviewersOpen(true)} />
                      <NavRow label={t("controlAdmin:appStorage.scanning.button")} onClick={() => setScanningFor(entry.library?.id ?? null)} />
                    </>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
      {view.enabled && (
        <div className="grouped-list-rows">
          <NavRow label={t("controlAdmin:appStorage.viewContents")} href={controlHref("storageContents")} />
        </div>
      )}

      {changing && (
        <Modal
          title={t("controlAdmin:appStorage.changeTitle")}
          className="system-data-chooser"
          onClose={() => setChanging(null)}
          onSubmit={(event) => {
            event.preventDefault();
            const folder = changing.where === "system" ? view.systemFolder : changing.path.trim();
            if (!folder) return;
            setPending({ kind: "change", where: changing.where, path: changing.where === "custom" ? changing.path.trim() : null, folder });
            setChanging(null);
          }}
        >
          <p>{t("controlAdmin:appStorage.changeIntro", { path: view.folder ?? "" })}</p>
          <div className="app-storage-options">
            <label className="app-storage-option">
              <input type="radio" name="app-storage-change" checked={changing.where === "system"} disabled={!view.systemDataSet} onChange={() => setChanging({ ...changing, where: "system" })} />
              <span>
                <strong>{t("controlAdmin:appStorage.whereSystem")}</strong>
                <small className="datagrid-muted">{view.systemFolder ?? t("controlAdmin:appStorage.needsSystemData")}</small>
              </span>
            </label>
            <label className="app-storage-option">
              <input type="radio" name="app-storage-change" checked={changing.where === "custom"} onChange={() => setChanging({ ...changing, where: "custom" })} />
              <span>
                <strong>{t("controlAdmin:appStorage.whereCustom")}</strong>
                <small className="datagrid-muted">{t("controlAdmin:appStorage.whereCustomHint")}</small>
              </span>
            </label>
          </div>
          {changing.where === "custom" && (
            <Field label={t("controlAdmin:appStorage.folderLabel")} value={changing.path} onChange={(path) => setChanging({ ...changing, path })} required={false} />
          )}
          <SpaceMeter space={changeSpace} />
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setChanging(null)} autoFocus>{t("common.cancel")}</Button>
            <Button
              variant="primary"
              type="submit"
              disabled={changing.where === "custom" ? !changing.path.trim() : !view.systemFolder || view.where === "system"}
            >
              {t("controlAdmin:appStorage.continue")}
            </Button>
          </div>
        </Modal>
      )}

      {reviewersOpen && (
        <InboxReviewersModal onClose={() => setReviewersOpen(false)} onChanged={() => void load().catch(() => undefined)} />
      )}

      {scanningFor && (
        <InboxScanningModal libraryId={scanningFor} onClose={() => setScanningFor(null)} />
      )}

      {pending && copy && (
        <ConfirmDialog
          title={copy.title}
          confirmLabel={copy.label}
          busyLabel={t("controlAdmin:ui.saving")}
          busy={saving}
          danger={copy.danger}
          rich={Boolean(copy.blocked)}
          confirmDisabled={Boolean(copy.blocked)}
          error={saveError || undefined}
          onConfirm={confirm}
          onCancel={() => { setPending(null); setSaveError(""); }}
        >
          {copy.blocked ? (
            <MessageBox tone="error" title={t("controlAdmin:appStorage.offRefusedTitle")}>{copy.blocked}</MessageBox>
          ) : copy.body}
        </ConfirmDialog>
      )}
    </section>
  );
}
