// Review mode — docs/photo-review-plan.md, phase 2.
//
// One Inbox delivery (or the whole Inbox), one photo at a time, four questions:
// when, where, who, and anything she remembers. Built for a person on a tablet
// who does not want to learn the app: no grid, no pencil icons, no map pin, no
// Save button. Next and Previous save; "I don't know" marks the photo looked at
// with nothing changed; "Same as the last one" copies the previous answer, which
// on a box from one summer is the button she presses most.
//
// Everything she writes lands on the photo itself (the PATCH the lightbox uses),
// so the Timeline, the map and every story that later uses the photo get it. A
// chrome-free page like the story reading view: it leaves the shell behind.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowRight, ChevronLeft, Image as ImageIcon, Mic } from "lucide-react";
import { api } from "../../../api";
import { goBack } from "../../../router";
import { Button } from "../../../shared/Button";
import { MessageBox } from "../../../shared/MessageBox";
import type { PhotoInboxSummary } from "../PhotoInboxPage";
import type { GalleryAsset, GalleryPerson, GalleryPersonTag, TakenPrecision } from "../types";
import { NEW_PERSON_PREFIX, PeopleChips } from "./PeopleChips";
import { WhenPicker, type WhenValue } from "./WhenPicker";
import { VoiceNotes } from "../VoiceNotes";
import { useDictation } from "./useDictation";
// Review mode's stylesheet: it loads with this page, not on every route (docs/css-map.md).
import "../../../styles/review.css";

const PAGE = 200;
const RECENT_PLACES = 10;

interface Draft {
  when: WhenValue;
  place: string;
  notes: string;
  people: GalleryPersonTag[];
}

/** The date fields a photo's stored date fills in. A date known only to the
 *  clock ('time') is almost always the scan date — the day the print went
 *  through the scanner — so it is NOT offered as an answer; only a date someone
 *  set on purpose (any coarser precision) comes back. */
function whenOf(asset: GalleryAsset): WhenValue {
  const blank: WhenValue = { year: "", month: "", day: "", approx: false };
  if (!asset.takenAt || asset.takenPrecision === "time") return blank;
  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(asset.takenAt);
  if (!parts) return blank;
  const precision = asset.takenPrecision;
  return {
    year: String(precision === "decade" ? Math.floor(Number(parts[1]) / 10) * 10 : Number(parts[1])),
    month: precision === "day" || precision === "month" ? String(Number(parts[2])) : "",
    day: precision === "day" ? String(Number(parts[3])) : "",
    approx: asset.takenApprox
  };
}

/** What the answer becomes on the wire: the period's first instant plus how
 *  far it was known. Null when no year was given. */
function whenToWire(when: WhenValue): { takenAt: string; takenPrecision: TakenPrecision; takenApprox: boolean } | null {
  if (!when.year) return null;
  const pad = (n: string) => n.padStart(2, "0");
  const month = when.month ? pad(when.month) : "01";
  const day = when.month && when.day ? pad(when.day) : "01";
  const takenPrecision: TakenPrecision = when.month ? (when.day ? "day" : "month") : "year";
  return { takenAt: `${when.year.padStart(4, "0")}-${month}-${day}T00:00:00.000Z`, takenPrecision, takenApprox: when.approx };
}

function sameWhen(a: WhenValue, b: WhenValue): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.approx === b.approx;
}

function draftOf(asset: GalleryAsset): Draft {
  return {
    when: whenOf(asset),
    place: asset.placeText ?? "",
    notes: asset.description ?? "",
    people: asset.people ?? []
  };
}

/** What Review mode walks: one Inbox (a delivery of it), or an album someone
 *  sent with "Ask what they remember" (phase 3), with the card it came from. */
export type ReviewSource =
  | { kind: "inbox"; libraryId: string; folder: string | null }
  | { kind: "album"; albumId: string; recommendationId: string | null };

export function ReviewPage({ source }: { source: ReviewSource }) {
  const { t } = useTranslation(["galleryReview", "common"]);
  // The name over the photos and whether she may write on them, whichever the source.
  const [context, setContext] = useState<{ name: string; canEdit: boolean } | null>(null);
  const [assets, setAssets] = useState<GalleryAsset[] | null>(null);
  const [people, setPeople] = useState<GalleryPerson[]>([]);
  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [large, setLarge] = useState(false);
  // The photo whose detail (people) is loading — a list row carries no people.
  const detailFor = useRef<string | null>(null);

  const asset = assets?.[index] ?? null;
  const canEdit = context?.canEdit === true;
  const total = assets?.length ?? 0;
  const reviewedCount = useMemo(() => (assets ?? []).filter((a) => a.reviewedAt).length, [assets]);

  // The Inbox (for its name and this viewer's rights), every photo of the
  // delivery in review order, and the names to offer as chips.
  const sourceKey = source.kind === "inbox" ? `inbox:${source.libraryId}:${source.folder ?? ""}` : `album:${source.albumId}`;
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        let name: string;
        let editable: boolean;
        const all: GalleryAsset[] = [];
        // Names offered as chips: the libraries she can browse, plus (for an
        // Inbox) anyone tagged in it, since the default scope leaves an Inbox out.
        const peopleUrls = ["/api/library/gallery/people"];

        if (source.kind === "inbox") {
          const { inboxes } = await api<{ inboxes: PhotoInboxSummary[] }>("/api/library/gallery/inbox");
          const found = inboxes.find((candidate) => candidate.id === source.libraryId);
          if (!found) throw new Error(t("galleryReview:errors.load"));
          for (let offset = 0; ; offset += PAGE) {
            const params = new URLSearchParams({ order: "review", limit: String(PAGE), offset: String(offset) });
            if (source.folder != null) params.set("folder", source.folder);
            const page = await api<{ items: GalleryAsset[]; total: number }>(`/api/library/gallery/inbox/${encodeURIComponent(source.libraryId)}/items?${params}`);
            all.push(...page.items);
            if (all.length >= page.total || page.items.length === 0) break;
          }
          name = source.folder || found.name;
          editable = found.canEdit;
          peopleUrls.push(`/api/library/gallery/people?libraryIds=${encodeURIComponent(source.libraryId)}`);
        } else {
          // An album sent with a question: its photos, unreviewed first, and
          // whether she may write on them (the share that came with the question).
          const review = await api<{ album: { id: string; name: string }; items: GalleryAsset[]; canEdit: boolean }>(
            `/api/library/gallery/review/album/${encodeURIComponent(source.albumId)}`
          );
          all.push(...review.items);
          name = review.album.name;
          editable = review.canEdit;
        }

        const lists = await Promise.all(peopleUrls.map((url) => api<{ people: GalleryPerson[] }>(url).catch(() => ({ people: [] as GalleryPerson[] }))));
        const byId = new Map<string, GalleryPerson>();
        for (const person of lists.flatMap((list) => list.people)) {
          const existing = byId.get(person.id);
          byId.set(person.id, existing ? { ...existing, faceCount: existing.faceCount + person.faceCount } : person);
        }
        if (!alive) return;
        setContext({ name, canEdit: editable });
        setAssets(all);
        setPeople(Array.from(byId.values()).filter((p) => p.name).sort((a, b) => b.faceCount - a.faceCount));
        document.title = t("galleryReview:docTitle", { name });
      } catch (err) {
        if (alive) setLoadError(err instanceof Error ? err.message : t("galleryReview:errors.load"));
      }
    })();
    return () => { alive = false; };
  }, [sourceKey, t]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reaching the end of an album someone asked about clears the card it came
  // from — the question has been answered, so it should stop waiting on Home.
  useEffect(() => {
    if (!done || source.kind !== "album" || !source.recommendationId) return;
    api(`/api/social/recommendations/${encodeURIComponent(source.recommendationId)}/dismiss`, { method: "POST" }).catch(() => { /* the card can be dismissed by hand */ });
  }, [done]); // eslint-disable-line react-hooks/exhaustive-deps

  // A fresh draft for each photo, with its people fetched from the detail.
  useEffect(() => {
    if (!asset) return;
    setDraft(draftOf(asset));
    setSaveError("");
    setLarge(false);
    if (asset.people && asset.voiceNotes) return;
    detailFor.current = asset.id;
    api<{ asset: GalleryAsset }>(`/api/library/gallery/assets/${encodeURIComponent(asset.id)}`)
      .then((payload) => {
        if (detailFor.current !== asset.id) return;
        const people = payload.asset.people ?? [];
        const voiceNotes = payload.asset.voiceNotes ?? [];
        setAssets((current) => current?.map((a) => (a.id === asset.id ? { ...a, people, voiceNotes } : a)) ?? current);
        setDraft((current) => (current ? { ...current, people } : current));
      })
      .catch(() => { /* the chips start empty; tagging still works */ });
  }, [asset?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Dictation appends each finished sentence to the notes as it is spoken.
  const dictation = useDictation(useCallback((text: string) => {
    if (!text) return;
    setDraft((current) => current ? { ...current, notes: current.notes ? `${current.notes.replace(/\s+$/, "")} ${text}` : text } : current);
  }, []));

  const patchAsset = useCallback((next: GalleryAsset) => {
    setAssets((current) => current?.map((a) => (a.id === next.id ? { ...a, ...next, people: next.people ?? a.people } : a)) ?? current);
  }, []);

  /** Save the current photo's answers and mark it gone through. Resolves to
   *  false when a save failed (the page stays on the photo and says so). */
  const save = useCallback(async (): Promise<boolean> => {
    if (!asset || !draft || !canEdit) return true;
    setBusy(true);
    setSaveError("");
    try {
      const body: Record<string, unknown> = {
        title: asset.title,
        description: draft.notes.trim() || null,
        takenAt: asset.takenAt,
        tags: asset.tags,
        placeText: draft.place.trim() || null,
        reviewed: true
      };
      if (draft.when.year && !sameWhen(draft.when, whenOf(asset))) {
        Object.assign(body, whenToWire(draft.when));
      }
      const saved = await api<{ asset: GalleryAsset }>(`/api/library/gallery/assets/${encodeURIComponent(asset.id)}`, {
        method: "PATCH",
        body: JSON.stringify(body)
      });
      let latest = saved.asset;

      // People: tag the added, untag the removed. A new name is created by the
      // tag call itself, which also links a same-named person if one exists.
      const before = new Set((asset.people ?? []).map((p) => p.id));
      const after = new Set(draft.people.map((p) => p.id));
      for (const person of draft.people) {
        if (before.has(person.id)) continue;
        const payload = person.id.startsWith(NEW_PERSON_PREFIX) ? { name: person.name } : { personId: person.id };
        const res = await api<{ asset: GalleryAsset }>(`/api/library/gallery/assets/${encodeURIComponent(asset.id)}/people`, {
          method: "POST",
          body: JSON.stringify(payload)
        });
        latest = { ...latest, people: res.asset?.people ?? latest.people };
        // Offer the new name on the next photo.
        const created = res.asset?.people?.find((p) => p.name.toLowerCase() === person.name.toLowerCase());
        if (created) setPeople((current) => current.some((p) => p.id === created.id) ? current : [...current, { id: created.id, name: created.name, faceCount: 1, coverUrl: null }]);
      }
      for (const id of before) {
        if (after.has(id)) continue;
        const res = await api<{ asset: GalleryAsset }>(`/api/library/gallery/assets/${encodeURIComponent(asset.id)}/people/${encodeURIComponent(id)}`, { method: "DELETE" });
        latest = { ...latest, people: res.asset?.people ?? latest.people };
      }
      if (!latest.people) latest = { ...latest, people: draft.people.filter((p) => !p.id.startsWith(NEW_PERSON_PREFIX)) };
      patchAsset(latest);
      return true;
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("galleryReview:errors.save"));
      return false;
    } finally {
      setBusy(false);
    }
  }, [asset, draft, canEdit, patchAsset, t]);

  const go = async (step: 1 | -1) => {
    if (busy || !assets) return;
    if (!(await save())) return;
    const next = index + step;
    if (next >= assets.length) { setDone(true); return; }
    if (next < 0) return;
    setIndex(next);
  };

  const dontKnow = async () => {
    if (busy || !asset || !assets) return;
    if (canEdit) {
      setBusy(true);
      setSaveError("");
      try {
        const res = await api<{ asset: GalleryAsset | null }>(`/api/library/gallery/assets/${encodeURIComponent(asset.id)}/reviewed`, { method: "POST" });
        if (res.asset) patchAsset(res.asset);
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : t("galleryReview:errors.save"));
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    const next = index + 1;
    if (next >= assets.length) setDone(true); else setIndex(next);
  };

  const leave = async () => {
    if (busy) return;
    if (asset && draft && canEdit) await save();
    goBack("/");
  };

  // "Same as the last one": the previous photo's answer, once it has one.
  const previous = index > 0 ? assets?.[index - 1] ?? null : null;
  const previousWhen = previous ? whenOf(previous) : null;
  const canCopyWhen = previousWhen !== null && previousWhen.year !== "";
  const canCopyWhere = Boolean(previous?.placeText);

  // Places she already wrote in this box, nearest first, as one-tap chips.
  const recentPlaces = useMemo(() => {
    if (!assets) return [] as string[];
    const seen: string[] = [];
    for (let i = index - 1; i >= 0 && seen.length < RECENT_PLACES; i -= 1) {
      const place = assets[i].placeText?.trim();
      if (place && !seen.includes(place)) seen.push(place);
    }
    for (let i = index + 1; i < assets.length && seen.length < RECENT_PLACES; i += 1) {
      const place = assets[i].placeText?.trim();
      if (place && !seen.includes(place)) seen.push(place);
    }
    return seen;
  }, [assets, index]);

  const progress = (
    <div className="review-progress" aria-label={t("galleryReview:progressAria")}>
      <span>{t("galleryReview:progress", { done: done ? total : Math.min(index + 1, total), total })}</span>
      <div className="review-bar" aria-hidden="true">
        <i style={{ width: `${total > 0 ? Math.round((done ? total : reviewedCount) / total * 100) : 0}%` }} />
      </div>
    </div>
  );

  return (
    <main className="review-page">
      <header className="review-top">
        <Button variant="bare" className="review-back" onClick={() => void leave()}>
          <ChevronLeft size={24} aria-hidden="true" />
          <span>{context ? context.name : t("galleryReview:back")}</span>
        </Button>
        {total > 0 && progress}
      </header>

      <div className="review-body">
        {loadError ? (
          <div className="review-empty">
            <MessageBox tone="error" title={t("galleryReview:errors.loadTitle")}>{loadError}</MessageBox>
            <Button variant="secondary" className="review-btn" onClick={() => goBack("/")}>{t("galleryReview:backToHome")}</Button>
          </div>
        ) : !assets || !context ? (
          <div className="review-loading"><p className="muted">{t("galleryReview:loading")}</p></div>
        ) : assets.length === 0 ? (
          <div className="review-empty">
            <h2>{t("galleryReview:empty.title")}</h2>
            <p>{t("galleryReview:empty.body")}</p>
            <Button variant="primary" className="review-btn" onClick={() => goBack("/")}>{t("galleryReview:backToHome")}</Button>
          </div>
        ) : done ? (
          <div className="review-done">
            <h2>{t("galleryReview:done.title")}</h2>
            <p>{t("galleryReview:done.body", { count: total, name: context.name })}</p>
            <Button variant="primary" className="review-btn" onClick={() => goBack("/")}>{t("galleryReview:backToHome")}</Button>
          </div>
        ) : asset && draft ? (
          <>
            <div
              className={`review-photo${large ? " is-large" : ""}`}
              onClick={() => setLarge((current) => !current)}
              role="button"
              tabIndex={0}
              aria-label={large ? t("galleryReview:closeLarge") : t("galleryReview:photoTapHint")}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setLarge((current) => !current); } }}
            >
              {asset.previewUrl || asset.coverUrl
                ? <img src={asset.previewUrl ?? asset.coverUrl ?? undefined} alt={t("galleryReview:photoAlt")} />
                : <span className="review-photo-fallback"><ImageIcon size={48} aria-hidden="true" /></span>}
            </div>

            <div className="review-form">
              {!canEdit && (
                <MessageBox tone="info" title={t("galleryReview:readOnly.title")}>
                  {source.kind === "album" ? t("galleryReview:album.readOnlyBody") : t("galleryReview:readOnly.body")}
                </MessageBox>
              )}

              <section className="review-q">
                <h2>{t("galleryReview:when.heading")}</h2>
                <WhenPicker value={draft.when} onChange={(when) => setDraft({ ...draft, when })} disabled={!canEdit || busy} />
                <div className="review-row">
                  <Button
                    variant="chip"
                    className="review-chip review-chip-same"
                    disabled={!canEdit || busy || !canCopyWhen}
                    onClick={() => { if (previousWhen) setDraft({ ...draft, when: previousWhen }); }}
                  >
                    {t("galleryReview:sameAsLast")}
                  </Button>
                </div>
              </section>

              <section className="review-q">
                <h2>{t("galleryReview:where.heading")}</h2>
                {recentPlaces.length > 0 && (
                  <div className="review-chips" role="group" aria-label={t("galleryReview:where.recentAria")}>
                    {recentPlaces.map((place) => (
                      <Button
                        variant="chip"
                        key={place}
                        className="review-chip"
                        aria-pressed={draft.place.trim() === place}
                        onClick={() => setDraft({ ...draft, place })}
                        disabled={!canEdit || busy}
                      >
                        {place}
                      </Button>
                    ))}
                  </div>
                )}
                <input
                  className="review-input"
                  value={draft.place}
                  onChange={(event) => setDraft({ ...draft, place: event.target.value })}
                  placeholder={t("galleryReview:where.placeholder")}
                  maxLength={300}
                  disabled={!canEdit || busy}
                  aria-label={t("galleryReview:where.heading")}
                />
                <div className="review-row">
                  <Button
                    variant="chip"
                    className="review-chip review-chip-same"
                    disabled={!canEdit || busy || !canCopyWhere}
                    onClick={() => setDraft({ ...draft, place: previous?.placeText ?? "" })}
                  >
                    {t("galleryReview:sameAsLast")}
                  </Button>
                </div>
              </section>

              <section className="review-q">
                <h2>{t("galleryReview:who.heading")}</h2>
                <PeopleChips
                  suggestions={people}
                  selected={draft.people}
                  onChange={(next) => setDraft({ ...draft, people: next })}
                  disabled={!canEdit || busy}
                />
              </section>

              <section className="review-q">
                <h2>{t("galleryReview:notes.heading")}</h2>
                <textarea
                  className="review-textarea"
                  value={draft.notes}
                  onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
                  placeholder={t("galleryReview:notes.placeholder")}
                  maxLength={5000}
                  disabled={!canEdit || busy}
                  aria-label={t("galleryReview:notes.heading")}
                />
                {canEdit && dictation.supported && (
                  <div className="review-row">
                    <Button
                      variant="chip"
                      className="review-chip"
                      aria-pressed={dictation.listening}
                      onClick={dictation.toggle}
                      disabled={busy}
                    >
                      <Mic size={18} aria-hidden="true" /> {dictation.listening ? t("galleryReview:notes.dictating") : t("galleryReview:notes.dictate")}
                    </Button>
                  </div>
                )}
                {/* A voice note is kept on the photo itself, next to the words. */}
                <p className="review-hint">{t("galleryReview:notes.orSay")}</p>
                <VoiceNotes
                  assetId={asset.id}
                  notes={asset.voiceNotes ?? []}
                  canEdit={canEdit && !busy}
                  large
                  heading={false}
                  thumbnailUrl={asset.coverUrl}
                  onChanged={(voiceNotes) => patchAsset({ ...asset, voiceNotes })}
                />
              </section>
            </div>
          </>
        ) : null}
      </div>

      {assets && assets.length > 0 && !done && !loadError && (
        <footer className="review-foot">
          {saveError && (
            <div className="review-error">
              <MessageBox tone="error" title={t("galleryReview:errors.saveTitle")}>{saveError}</MessageBox>
            </div>
          )}
          <Button variant="secondary" className="review-btn" onClick={() => void go(-1)} disabled={busy || index === 0}>
            <ArrowLeft size={20} aria-hidden="true" />
            <span>{t("galleryReview:previous")}</span>
          </Button>
          <Button variant="text" className="review-btn review-btn-dontknow" onClick={() => void dontKnow()} disabled={busy}>
            {t("galleryReview:dontKnow")}
          </Button>
          <Button variant="primary" className="review-btn" onClick={() => void go(1)} disabled={busy}>
            <span>{busy ? t("galleryReview:saving") : t("galleryReview:next")}</span>
            <ArrowRight size={20} aria-hidden="true" />
          </Button>
        </footer>
      )}
    </main>
  );
}
