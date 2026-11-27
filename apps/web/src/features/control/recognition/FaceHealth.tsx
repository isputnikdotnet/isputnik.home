import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Combine, Stethoscope, UserRound } from "lucide-react";
import i18n from "../../../i18n";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { MessageBox } from "../../../shared/MessageBox";
import { formatNumber } from "../../../shared/dates";
import type { ClusterHealth, ClusterHealthPair, ClusterHealthPerson } from "../../gallery/types";

// The people check: how many people are probably the same person in two groups,
// and one-click merges for the likeliest pairs. People are shared by every gallery
// library, so this is one check for the whole install, on the Recognition page
// (it was the "Health" tab of the face recognition dialog until 4.93).
//
// It compares every person with every other, so it runs when asked: when its
// popup is opened, and again from "Check again".

function personLabel(person: ClusterHealthPerson): string {
  const count = i18n.t("galleryModals:common.photoCount", { count: person.faceCount });
  return `${person.name.trim() || i18n.t("galleryModals:faceSettings.unnamed")} · ${count}`;
}

// A person's picture, with the People grid's fallback when the crop cannot load.
function HealthAvatar({ person }: { person: ClusterHealthPerson }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="gallery-health-avatar">
      {person.coverUrl && !failed
        ? <img src={person.coverUrl} alt="" loading="lazy" onError={() => setFailed(true)} />
        : <UserRound size={26} aria-hidden="true" />}
    </span>
  );
}

export function FaceHealth({ autoRun = false }: { /** Run the check as soon as this is shown (its popup was just opened). */ autoRun?: boolean }) {
  const { t } = useTranslation(["common", "galleryModals", "controlAdmin"]);
  const [health, setHealth] = useState<ClusterHealth | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [mergingKey, setMergingKey] = useState<string | null>(null);

  const check = async () => {
    setLoading(true);
    setError("");
    try {
      setHealth(await api<ClusterHealth>("/api/library/gallery/faces/cluster-health"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("galleryModals:faceSettings.unableToCheckClustering"));
    } finally {
      setLoading(false);
    }
  };

  // Opening the popup IS asking for the check. Once: the flags it sets must not
  // start it again.
  useEffect(() => {
    if (autoRun) void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fold one suggested pair together (b into a), then take it off the list.
  const merge = async (pair: ClusterHealthPair) => {
    const key = `${pair.a.id}:${pair.b.id}`;
    setMergingKey(key);
    setError("");
    try {
      await api(`/api/library/gallery/people/${pair.b.id}/merge`, { method: "POST", body: JSON.stringify({ intoId: pair.a.id }) });
      setHealth((current) => (current
        ? { ...current, pairs: current.pairs.filter((p) => `${p.a.id}:${p.b.id}` !== key), peopleWithTwin: Math.max(0, current.peopleWithTwin - 2) }
        : current));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("galleryModals:faceSettings.unableToMerge"));
    } finally {
      setMergingKey(null);
    }
  };

  const bars = (found: ClusterHealth) => {
    const max = Math.max(1, found.bands.nearCertain, found.bands.likely, found.bands.possible);
    const bar = (label: string, count: number, hint: string) => (
      <div className="gallery-health-bar-row" key={label}>
        <span className="gallery-health-bar-label">{label}</span>
        <span className="gallery-health-bar-track">
          <span className="gallery-health-bar-fill" style={{ width: `${Math.round((count / max) * 100)}%` }} />
        </span>
        <span className="gallery-health-bar-count">{formatNumber(count)}</span>
        <span className="gallery-health-bar-hint muted">{hint}</span>
      </div>
    );
    return (
      <div className="gallery-health-bars">
        {bar(`≥ ${found.mergeLine}`, found.bands.nearCertain, t("galleryModals:faceSettings.bandNearCertain"))}
        {bar(`0.52–${found.mergeLine}`, found.bands.likely, t("galleryModals:faceSettings.bandLikely"))}
        {bar("0.45–0.52", found.bands.possible, t("galleryModals:faceSettings.bandPossible"))}
      </div>
    );
  };

  return (
    <div className="gallery-face-health recognition-health">
      {error && <MessageBox tone="error" title={t("galleryModals:faceSettings.unableToCheckTitle")}>{error}</MessageBox>}
      {loading && <p className="management-empty">{t("galleryModals:faceSettings.checkingBody")}</p>}
      {!loading && health && (health.totalPeople === 0 ? (
        <MessageBox tone="info" title={t("galleryModals:faceSettings.noPeopleTitle")}>
          {t("galleryModals:faceSettings.noPeopleBody")}
        </MessageBox>
      ) : (
        <>
          <p className="gallery-health-summary">
            <strong>{t("galleryModals:faceSettings.summaryTotal", { count: health.totalPeople })}</strong> ·{" "}
            <strong>{t("galleryModals:faceSettings.summaryTwin", { count: health.peopleWithTwin })}</strong>
            {" "}{t("galleryModals:faceSettings.summaryTwinHint")}
          </p>
          {bars(health)}
          <p className="muted gallery-health-explain">{t("galleryModals:faceSettings.explain", { mergeLine: health.mergeLine })}</p>
          {health.pairs.length === 0 ? (
            <MessageBox tone="success" title={t("galleryModals:faceSettings.wellMergedTitle")}>
              {t("galleryModals:faceSettings.wellMergedBody")}
            </MessageBox>
          ) : (
            <ul className="gallery-health-pairs">
              {health.pairs.map((pair) => {
                const key = `${pair.a.id}:${pair.b.id}`;
                return (
                  <li key={key} className="gallery-health-pair">
                    <div className="gallery-health-avatars">
                      <HealthAvatar person={pair.a} />
                      <HealthAvatar person={pair.b} />
                    </div>
                    <div className="gallery-health-pair-info">
                      <span>{personLabel(pair.a)}</span>
                      <span className="muted">{personLabel(pair.b)}</span>
                      <span className="gallery-health-sim">{t("galleryModals:faceSettings.matchPercent", { percent: Math.round(pair.similarity * 100) })}</span>
                    </div>
                    <Button variant="primary" compact disabled={mergingKey === key} onClick={() => void merge(pair)}>
                      <Combine size={14} aria-hidden="true" /> {mergingKey === key ? t("galleryModals:faceSettings.merging") : t("galleryModals:faceSettings.merge")}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ))}
      <div className="gallery-health-recheck">
        <Button variant="secondary" compact disabled={loading} onClick={() => void check()}>
          <Stethoscope size={14} aria-hidden="true" /> {health ? t("galleryModals:faceSettings.recheck") : t("controlAdmin:recognition.healthRun")}
        </Button>
      </div>
    </div>
  );
}
