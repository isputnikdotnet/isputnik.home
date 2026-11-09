import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Images, Plus, Presentation, Tv } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { SelectField } from "../../shared/SelectField";
import type { GalleryAlbum, GallerySlideshow } from "./types";

// Photos on the TV (docs/tv-photos-plan.md): the household's "On TV" list, an admin's.
// Only the slideshows and albums here reach a TV, in this order, each for an audience
// of viewing profiles. A person's own access still applies on top, on the server.

const PICKS_API = "/api/library/gallery/tv/picks";

type Audience = "everyone" | "grownups" | "chosen";

interface TvPick {
  id: string;
  kind: "slideshow" | "album";
  refId: string;
  name: string | null;
  coverUrl: string | null;
  itemCount: number;
  audience: Audience;
  profileIds: string[];
}

interface PicksAnswer {
  picks: TvPick[];
  max: number;
}

interface ProfileRef {
  id: string;
  name: string;
  restricted: boolean;
}

/** "Without a profile": someone watching as themselves. */
const NO_PROFILE = "";

export function TvPicksModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(["common", "gallery"]);
  const [answer, setAnswer] = useState<PicksAnswer | null>(null);
  const [profiles, setProfiles] = useState<ProfileRef[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  /** Choosing what to add: slideshows or albums not on the list yet. */
  const [adding, setAdding] = useState<"slideshow" | "album" | null>(null);

  useEffect(() => {
    api<PicksAnswer>(PICKS_API).then(setAnswer).catch((err: unknown) => setError(err instanceof Error ? err.message : t("gallery:tv.loadFailed")));
    api<{ profiles: ProfileRef[] }>("/api/profiles").then((payload) => setProfiles(payload.profiles)).catch(() => setProfiles([]));
  }, [t]);

  const send = useCallback(async (request: Promise<PicksAnswer>) => {
    setBusy(true);
    setError("");
    try {
      setAnswer(await request);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:tv.saveFailed"));
    } finally {
      setBusy(false);
    }
  }, [t]);

  const picks = answer?.picks ?? [];
  const setAudience = (pick: TvPick, audience: Audience, profileIds = pick.profileIds) =>
    void send(api<PicksAnswer>(`${PICKS_API}/${pick.id}`, { method: "PATCH", body: JSON.stringify({ audience, profileIds }) }));
  const move = (index: number, by: number) => {
    const ids = picks.map((pick) => pick.id);
    const to = index + by;
    if (to < 0 || to >= ids.length) return;
    [ids[index], ids[to]] = [ids[to], ids[index]];
    void send(api<PicksAnswer>(`${PICKS_API}/order`, { method: "PUT", body: JSON.stringify({ ids }) }));
  };
  const remove = (pick: TvPick) => void send(api<PicksAnswer>(`${PICKS_API}/${pick.id}`, { method: "DELETE" }));
  const add = async (kind: "slideshow" | "album", id: string) => {
    await send(api<PicksAnswer>(PICKS_API, { method: "POST", body: JSON.stringify(kind === "slideshow" ? { slideshowId: id } : { albumId: id }) }));
    setAdding(null);
  };
  const full = answer ? picks.length >= answer.max : true;
  const audienceChoices = (pick: TvPick) => [
    { value: "grownups" as Audience, label: t("gallery:tv.audienceGrownups") },
    { value: "everyone" as Audience, label: t("gallery:tv.audienceEveryone") },
    { value: "chosen" as Audience, label: pick.audience === "chosen" ? t("gallery:tv.audienceChosenCount", { count: pick.profileIds.length }) : t("gallery:tv.audienceChosen") }
  ];
  const audienceTargets = [{ id: NO_PROFILE, name: t("gallery:tv.withoutProfile") }, ...profiles];

  return (
    <Modal variant="panel" title={t("gallery:tv.title")} icon={<Tv size={20} />} className="tv-picks-modal" busy={busy} onClose={onClose}>
      <div className="modal-tab-content tv-picks">
        {adding ? (
          <AddPick kind={adding} onAdd={(id) => void add(adding, id)} onBack={() => setAdding(null)} busy={busy} taken={picks.filter((pick) => pick.kind === adding).map((pick) => pick.refId).join(",")} />
        ) : (
          <>
            <p className="muted">{t("gallery:tv.intro")}</p>
            {error && <MessageBox tone="error" title={t("gallery:tv.saveFailed")}>{error}</MessageBox>}
            {answer && picks.length === 0 && <p className="muted">{t("gallery:tv.none")}</p>}
            <ol className="tv-picks-list">
              {picks.map((pick, index) => {
                const name = pick.name ?? t("gallery:tv.unnamed");
                return (
                  <li key={pick.id}>
                    <span className="tv-picks-cover" aria-hidden="true">
                      {pick.coverUrl ? <img src={pick.coverUrl} alt="" /> : pick.kind === "slideshow" ? <Presentation size={18} /> : <Images size={18} />}
                    </span>
                    <span className="tv-picks-text">
                      <strong>{name}</strong>
                      <span>
                        {pick.kind === "slideshow" ? t("gallery:tv.kindSlideshow") : t("gallery:tv.kindAlbum")}
                        {" · "}
                        {t("gallery:tv.photos", { count: pick.itemCount })}
                      </span>
                      {pick.audience === "chosen" && (
                        <span className="tv-picks-checks" role="group" aria-label={t("gallery:tv.profilesLabel", { name })}>
                          {audienceTargets.map((target) => (
                            <label key={target.id || "none"}>
                              <input
                                type="checkbox"
                                checked={pick.profileIds.includes(target.id)}
                                disabled={busy}
                                onChange={() => setAudience(pick, "chosen", pick.profileIds.includes(target.id) ? pick.profileIds.filter((id) => id !== target.id) : [...pick.profileIds, target.id])}
                              />
                              <span>{target.name}</span>
                            </label>
                          ))}
                        </span>
                      )}
                    </span>
                    <SelectField<Audience>
                      label={t("gallery:tv.audienceLabel")}
                      value={pick.audience}
                      onChange={(audience) => setAudience(pick, audience, audience === "chosen" ? pick.profileIds : [])}
                      options={audienceChoices(pick)}
                    />
                    <Button variant="icon" aria-label={t("gallery:tv.moveUp", { name })} title={t("gallery:tv.moveUp", { name })} disabled={busy || index === 0} onClick={() => move(index, -1)}>
                      <ArrowUp size={16} aria-hidden="true" />
                    </Button>
                    <Button variant="icon" aria-label={t("gallery:tv.moveDown", { name })} title={t("gallery:tv.moveDown", { name })} disabled={busy || index === picks.length - 1} onClick={() => move(index, 1)}>
                      <ArrowDown size={16} aria-hidden="true" />
                    </Button>
                    <Button variant="text" disabled={busy} onClick={() => remove(pick)}>{t("gallery:tv.remove")}</Button>
                  </li>
                );
              })}
            </ol>
            <div className="tv-picks-add">
              <Button variant="secondary" disabled={busy || full} title={full ? t("gallery:tv.full", { max: answer?.max ?? 0 }) : undefined} onClick={() => setAdding("slideshow")}>
                <Plus size={16} aria-hidden="true" />
                {t("gallery:tv.addSlideshow")}
              </Button>
              <Button variant="secondary" disabled={busy || full} title={full ? t("gallery:tv.full", { max: answer?.max ?? 0 }) : undefined} onClick={() => setAdding("album")}>
                <Plus size={16} aria-hidden="true" />
                {t("gallery:tv.addAlbum")}
              </Button>
            </div>
            <div className="modal-actions">
              <Button variant="secondary" disabled={busy} onClick={onClose}>{t("common:common.close")}</Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/** The slideshows or albums not on the list yet, to put one on it. */
function AddPick({ kind, taken, busy, onAdd, onBack }: {
  kind: "slideshow" | "album";
  /** Ids already on the list, comma-separated (a string, so the list loads once). */
  taken: string;
  busy: boolean;
  onAdd: (id: string) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  const [items, setItems] = useState<{ id: string; name: string; itemCount: number; coverUrl: string | null }[] | null>(null);
  useEffect(() => {
    const load = kind === "slideshow"
      ? api<{ slideshows: GallerySlideshow[] }>("/api/library/gallery/slideshows").then((payload) => payload.slideshows)
      : api<{ albums: GalleryAlbum[] }>("/api/library/gallery/albums").then((payload) => payload.albums);
    const onTv = new Set(taken.split(",").filter(Boolean));
    load.then((list) => setItems(list.filter((entry) => !onTv.has(entry.id) && entry.itemCount > 0))).catch(() => setItems([]));
  }, [kind, taken]);
  return (
    <>
      <h3 className="tv-picks-heading">{kind === "slideshow" ? t("gallery:tv.chooseSlideshow") : t("gallery:tv.chooseAlbum")}</h3>
      {items && items.length === 0 && <p className="muted">{kind === "slideshow" ? t("gallery:tv.noSlideshowsLeft") : t("gallery:tv.noAlbumsLeft")}</p>}
      <ul className="tv-picks-list">
        {(items ?? []).map((entry) => (
          <li key={entry.id}>
            <span className="tv-picks-cover" aria-hidden="true">
              {entry.coverUrl ? <img src={entry.coverUrl} alt="" /> : kind === "slideshow" ? <Presentation size={18} /> : <Images size={18} />}
            </span>
            <span className="tv-picks-text">
              <strong>{entry.name}</strong>
              <span>{t("gallery:tv.photos", { count: entry.itemCount })}</span>
            </span>
            <Button variant="secondary" disabled={busy} onClick={() => onAdd(entry.id)}>{t("gallery:tv.put")}</Button>
          </li>
        ))}
      </ul>
      <div className="modal-actions">
        <Button variant="secondary" disabled={busy} onClick={onBack}>{t("gallery:tv.back")}</Button>
      </div>
    </>
  );
}
