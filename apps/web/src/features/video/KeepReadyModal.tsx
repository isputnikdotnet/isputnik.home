import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, api } from "../../api";
import { Button } from "../../shared/Button";
import { GroupedList, InfoRow, ToggleRow } from "../../shared/GroupedList";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { formatBytes } from "../../shared/utils";
import { VIDEO_API } from "./types";

// Keep ready (docs/video-cache-plan.md C3), for an admin on a film's or show's
// page: the qualities the video engine converts it to ahead of time and keeps, so
// it plays with nothing converted and downloads at once. A show can bring its new
// episodes along. Versions that play as they are at a quality need nothing.

export type KeepRung = 1080 | 720 | 480;
const RUNGS: KeepRung[] = [1080, 720, 480];

/** One marked title as GET/PUT {VIDEO_API}/admin/keep-ready answers it (engine 0.35+). */
export interface KeepReadyTitle {
  id: string;
  kind: "movie" | "show" | "season";
  targetId: string;
  season: number | null;
  rungs: KeepRung[];
  newEpisodes: boolean;
  title: string;
  total: number;
  ready: number;
  asIs: number;
  waiting: number;
  missing: number;
  sizeBytes: number;
  estimateBytes: number;
  making: { title: string; rung: number; progress: number } | null;
}

export interface KeepReadyState {
  available: boolean;
  titles: KeepReadyTitle[];
}

export const KEEP_READY_URL = `${VIDEO_API}/admin/keep-ready`;

export function KeepReadyModal({ kind, id, season, name, onClose }: {
  kind: "movie" | "show" | "season";
  id: string;
  season?: number;
  /** What the dialog calls it: the film, the show, or the show and season. */
  name: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<KeepReadyState | null>(null);
  const [rungs, setRungs] = useState<Set<KeepRung>>(new Set([720]));
  const [newEpisodes, setNewEpisodes] = useState(true);
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState("");

  const mine = state?.titles.find((title) => title.kind === kind && title.targetId === id && (kind !== "season" || title.season === season)) ?? null;

  useEffect(() => {
    let live = true;
    api<KeepReadyState>(KEEP_READY_URL).then((answer) => {
      if (!live) return;
      setState(answer);
      const found = answer.titles.find((title) => title.kind === kind && title.targetId === id && (kind !== "season" || title.season === season));
      if (found) {
        setRungs(new Set(found.rungs));
        setNewEpisodes(found.newEpisodes);
      }
    }, (err: unknown) => { if (live) setError(err instanceof Error ? err.message : t("video.keepReady.loadFailed")); });
    return () => { live = false; };
  }, [kind, id, season, t]);

  const toggle = (rung: KeepRung, on: boolean) => setRungs((current) => {
    const next = new Set(current);
    if (on) next.add(rung);
    else next.delete(rung);
    return next;
  });

  const save = async () => {
    setBusy("save");
    setError("");
    try {
      await api<KeepReadyState>(KEEP_READY_URL, {
        method: "PUT",
        body: JSON.stringify({ kind, id, ...(kind === "season" ? { season } : {}), rungs: [...rungs], ...(kind !== "movie" ? { newEpisodes } : {}) })
      });
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && (err.body as { code?: string } | undefined)?.code === "room") {
        const body = err.body as { neededBytes: number; limitBytes: number };
        setError(t("video.keepReady.noRoom", { needed: formatBytes(body.neededBytes), limit: formatBytes(body.limitBytes) }));
      } else {
        setError(err instanceof Error ? err.message : t("video.keepReady.saveFailed"));
      }
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!mine) return;
    setBusy("remove");
    setError("");
    try {
      await api<KeepReadyState>(`${KEEP_READY_URL}?id=${encodeURIComponent(mine.id)}`, { method: "DELETE" });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("video.keepReady.saveFailed"));
      setBusy(null);
    }
  };

  return (
    <Modal variant="card" title={t("video.keepReady.title", { name })} busy={busy !== null} onClose={onClose}>
      <p className="muted">{t("video.keepReady.intro")}</p>
      {error && <MessageBox tone="error" title={t("video.keepReady.failedTitle")}>{error}</MessageBox>}
      {!state && !error && <p className="muted">{t("video.keepReady.loading")}</p>}
      {state && !state.available && (
        <MessageBox tone="info" title={t("video.keepReady.unavailableTitle")}>{t("video.keepReady.unavailableBody")}</MessageBox>
      )}
      {state?.available && (
        <>
          {mine && (
            <GroupedList>
              <InfoRow
                label={t("video.keepReady.status", { ready: mine.ready, total: mine.total - mine.asIs - mine.missing })}
                sub={[
                  mine.asIs > 0 ? t("video.keepReady.asIs", { count: mine.asIs }) : null,
                  mine.making ? t("video.keepReady.making", { title: mine.making.title, percent: Math.round(mine.making.progress * 100) }) : null,
                  mine.waiting > 0 && !mine.making ? t("video.keepReady.waiting", { count: mine.waiting }) : null
                ].filter(Boolean).join(" · ") || undefined}
                value={formatBytes(mine.sizeBytes)}
              />
            </GroupedList>
          )}
          <GroupedList title={t("video.keepReady.qualities")} note={t("video.keepReady.qualitiesNote")}>
            {RUNGS.map((rung) => (
              <ToggleRow key={rung} label={t("video.keepReady.rung", { height: rung })} checked={rungs.has(rung)} disabled={busy !== null} onChange={(on) => toggle(rung, on)} />
            ))}
          </GroupedList>
          {kind !== "movie" && (
            <GroupedList>
              <ToggleRow label={t("video.keepReady.newEpisodes")} sub={t("video.keepReady.newEpisodesNote")} checked={newEpisodes} disabled={busy !== null} onChange={setNewEpisodes} />
            </GroupedList>
          )}
        </>
      )}
      <div className="modal-actions">
        {mine && (
          <Button variant="danger" disabled={busy !== null} onClick={() => void remove()}>
            {busy === "remove" ? t("video.keepReady.removing") : t("video.keepReady.remove")}
          </Button>
        )}
        <Button variant="secondary" disabled={busy !== null} onClick={onClose}>{t("common.cancel")}</Button>
        {state?.available && (
          <Button variant="primary" disabled={busy !== null || rungs.size === 0} onClick={() => void save()}>
            {busy === "save" ? t("video.keepReady.saving") : t("video.keepReady.save")}
          </Button>
        )}
      </div>
    </Modal>
  );
}
