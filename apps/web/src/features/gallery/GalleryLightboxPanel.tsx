import { lazy, Suspense, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Calendar, FileText, FolderOpen, MapPin, Plus, Replace, RotateCcw, RotateCw, Tag, Users, X } from "lucide-react";
import { api } from "../../api";
import { formatBytes } from "../../shared/utils";
import { CLIP_LENGTH, formatClock } from "../../shared/formatClock";
import { NotesSection } from "../social/NotesSection";
import { GalleryPlaceSearch } from "./GalleryPlaceSearch";
import { VoiceNotes } from "./VoiceNotes";
import type { GalleryAsset, GalleryPerson, GalleryPersonTag, TakenPrecision, VoiceNote } from "./types";
import type { GalleryAssetChange } from "./GalleryLightbox";
import { TAKEN_PRECISIONS, formatTakenDate, precisionLabel, takenInputToIso, takenInputType, takenInputValue } from "./taken-date";
import { PLACE_NAMES_CREDIT_URL, formatPlaceLabel } from "./place-label";
import { Button } from "../../shared/Button";
import { formatDate, formatDateTime } from "../../shared/dates";

// The lightbox's side panel: three tabs over one photo.
//
//   Details — what the family knows: when, where, who, tags, the description,
//             recordings, and the notes people leave under it.
//   Map     — where it was taken, with the pin editor.
//   File    — what the camera and the disk know, plus rotate/replace.
//
// Design: docs/lightbox-panel.md. The panel owns every edit it offers (the
// lightbox only learns that the asset changed, through onChanged), so the viewer
// stays about showing the photo and the panel about writing on it.
//
// Leaflet rides in only when a tab shows a map — keeps it off the initial bundle
// (and reuses the same chunk as the gallery Map view).
const GalleryMiniMap = lazy(() => import("./GalleryMiniMap").then((m) => ({ default: m.GalleryMiniMap })));
const GalleryLocationPicker = lazy(() => import("./GalleryLocationPicker").then((m) => ({ default: m.GalleryLocationPicker })));

export type PanelTab = "details" | "map" | "file";

// Fields editable inline ("gps" opens the map picker on the Map tab). The name and
// technical fields stay read-only: the title is the file on disk. "placeText" is
// the place as a person wrote it, beside the pin (docs/photo-review-plan.md).
type EditableField = "description" | "takenAt" | "placeText" | "tags" | "gps";

// The letter a person's chip shows when no face crop is known for them.
function initial(name: string): string {
  const first = name.trim().charAt(0);
  return first ? first.toUpperCase() : "?";
}

export function GalleryLightboxPanel({
  asset,
  canEdit,
  onChanged,
  onOpenFolder,
  onClose,
  onRotate,
  rotateBusy,
  onReplace
}: {
  asset: GalleryAsset;
  canEdit: boolean;
  onChanged: (change: GalleryAssetChange) => void;
  // When set, the Folder entry becomes a link that closes the lightbox and opens
  // that folder in the gallery's Folders view.
  onOpenFolder?: (folder: string) => void;
  onClose: () => void;
  // Rotate and replace live on the File tab; the lightbox performs them because
  // the stage has to react (a rotated video is counter-rotated live).
  onRotate?: (direction: "cw" | "ccw") => void;
  rotateBusy?: boolean;
  onReplace?: () => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  // The tab survives moving to the next photo: browsing a trip on the Map tab
  // is a thing to do.
  const [tab, setTab] = useState<PanelTab>("details");

  // Inline field editing (one field at a time).
  const [editingField, setEditingField] = useState<EditableField | null>(null);
  const [editValue, setEditValue] = useState("");
  // The date editor's "how exact" and "about" — a print from a box is "1962",
  // not a timestamp (taken-date.ts).
  const [editPrecision, setEditPrecision] = useState<TakenPrecision>("time");
  const [editApprox, setEditApprox] = useState(false);
  // The point picked on the location editor's map (separate from the text fields).
  const [editGps, setEditGps] = useState<{ lat: number; lng: number } | null>(null);
  // A place-search result: its name (shown beside the coordinates until the pin is
  // moved by hand) and the nonce-keyed instruction that recentres the map on it.
  const [editGpsLabel, setEditGpsLabel] = useState("");
  const [editGpsFocus, setEditGpsFocus] = useState<{ lat: number; lng: number; zoom?: number; nonce: number } | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState("");

  // People tagged in this asset. The list/timeline rows don't carry `people`, so when
  // it's absent we fetch the asset detail. `allPeople` feeds the add-box suggestions
  // and lends its face crops to the chips.
  const [people, setPeople] = useState<GalleryPersonTag[]>(asset.people ?? []);
  // Voice notes ride the same detail fetch as people (list rows carry neither).
  const [voiceNotes, setVoiceNotes] = useState<VoiceNote[] | null>(asset.voiceNotes ?? null);
  const [allPeople, setAllPeople] = useState<GalleryPerson[]>([]);
  const [addingPerson, setAddingPerson] = useState(false);
  const [personName, setPersonName] = useState("");
  const [personBusy, setPersonBusy] = useState(false);
  const [personError, setPersonError] = useState("");

  // Moving to another asset abandons any in-progress edit.
  useEffect(() => { setEditingField(null); setEditError(""); }, [asset.id]);

  // Load the current asset's people (from the detail endpoint when the row lacks them).
  useEffect(() => {
    setAddingPerson(false);
    setPersonName("");
    setPersonError("");
    setVoiceNotes(asset.voiceNotes ?? null);
    if (asset.people && asset.voiceNotes) { setPeople(asset.people); return; }
    let alive = true;
    api<{ asset: GalleryAsset }>(`/api/library/gallery/assets/${asset.id}`)
      .then((p) => {
        if (!alive) return;
        setPeople(p.asset.people ?? []);
        setVoiceNotes(p.asset.voiceNotes ?? []);
      })
      .catch(() => { /* keep whatever we have */ });
    return () => { alive = false; };
  }, [asset.id, asset.people, asset]);

  // Suggestions for the add-box: the existing people, refreshed after each change so a
  // freshly-created person becomes selectable.
  useEffect(() => {
    if (!canEdit) return;
    let alive = true;
    api<{ people: GalleryPerson[] }>("/api/library/gallery/people")
      .then((p) => { if (alive) setAllPeople(p.people); })
      .catch(() => { /* suggestions are advisory */ });
    return () => { alive = false; };
  }, [canEdit, people]);

  const startEdit = (field: EditableField) => {
    setEditError("");
    setEditingField(field);
    // Reopening the editor starts from the asset's own point, with no leftover
    // search result naming or recentring it.
    if (field === "gps") { setEditGps(asset.gps); setEditGpsLabel(""); setEditGpsFocus(null); return; }
    if (field === "takenAt") {
      const precision = asset.takenPrecision ?? "time";
      setEditPrecision(precision);
      setEditApprox(asset.takenApprox === true);
      setEditValue(takenInputValue(asset.takenAt, precision));
      return;
    }
    setEditValue(
      field === "description" ? (asset.description ?? "")
        : field === "placeText" ? (asset.placeText ?? "")
          : "" // tags: the input adds to the chips, it does not re-edit the list
    );
  };

  // Switching the date editor's precision re-reads the same date at the new
  // grain ("14 Jul 1962" → "1962") rather than blanking the field.
  const changeEditPrecision = (next: TakenPrecision) => {
    const iso = takenInputToIso(editValue, editPrecision) ?? asset.takenAt;
    setEditPrecision(next);
    setEditValue(takenInputValue(iso, next));
  };

  const cancelEdit = () => { setEditingField(null); setEditError(""); };

  // The PATCH endpoint wants the full editable payload (title is required, tags
  // default to []), so each save sends the asset's current values with just the
  // edited field swapped in. An omitted `gps` means "leave it alone".
  type PatchBody = {
    title: string; description: string | null; takenAt: string | null; tags: string[];
    takenPrecision?: TakenPrecision; takenApprox?: boolean; placeText?: string | null;
    gps?: { lat: number; lng: number } | null;
  };
  const patch = async (change: Partial<PatchBody>, fallbackError: string) => {
    if (editBusy) return;
    const body: PatchBody = {
      title: asset.title,
      description: asset.description,
      takenAt: asset.takenAt,
      tags: asset.tags,
      ...change
    };
    setEditBusy(true);
    setEditError("");
    try {
      await api(`/api/library/gallery/assets/${asset.id}`, { method: "PATCH", body: JSON.stringify(body) });
      setEditingField(null);
      onChanged({ kind: "asset", id: asset.id });
    } catch (err) {
      setEditError(err instanceof Error ? err.message : fallbackError);
    } finally {
      setEditBusy(false);
    }
  };

  const saveLocation = (next: { lat: number; lng: number } | null) =>
    patch({ gps: next }, t("gallery:lightbox.errors.saveLocation"));

  const saveEdit = async () => {
    if (!editingField) return;
    const fallback = t("gallery:lightbox.errors.saveChanges");
    if (editingField === "description") return patch({ description: editValue.trim() || null }, fallback);
    if (editingField === "placeText") return patch({ placeText: editValue.trim() || null }, fallback);
    if (editingField === "takenAt") {
      // The server floors the instant to the precision; an empty field leaves
      // the date as it is (the PATCH has no "clear the date" — see edit.ts).
      return patch({ takenAt: takenInputToIso(editValue, editPrecision), takenPrecision: editPrecision, takenApprox: editApprox }, fallback);
    }
    // Tags: whatever was typed (comma-separated) joins the chips already there.
    const typed = editValue.split(",").map((tag) => tag.trim()).filter(Boolean);
    if (typed.length === 0) { cancelEdit(); return; }
    return patch({ tags: Array.from(new Set([...asset.tags, ...typed])) }, fallback);
  };

  const removeTag = (tag: string) =>
    patch({ tags: asset.tags.filter((other) => other !== tag) }, t("gallery:lightbox.errors.saveChanges"));

  // Tag a person: link an existing one when the typed name matches (case-insensitive),
  // otherwise create a new person. The API returns the updated asset with its people.
  const addPerson = async () => {
    const name = personName.trim();
    if (!name || personBusy) return;
    setPersonBusy(true);
    setPersonError("");
    try {
      const match = allPeople.find((p) => p.name.toLowerCase() === name.toLowerCase());
      const body = match ? { personId: match.id } : { name };
      const res = await api<{ asset: GalleryAsset }>(
        `/api/library/gallery/assets/${asset.id}/people`,
        { method: "POST", body: JSON.stringify(body) }
      );
      setPeople(res.asset.people ?? []);
      setPersonName("");
      setAddingPerson(false);
      onChanged({ kind: "asset", id: asset.id });
    } catch (err) {
      setPersonError(err instanceof Error ? err.message : t("gallery:lightbox.errors.tagPerson"));
    } finally {
      setPersonBusy(false);
    }
  };

  const removePerson = async (personId: string) => {
    try {
      const res = await api<{ asset: GalleryAsset }>(
        `/api/library/gallery/assets/${asset.id}/people/${personId}`,
        { method: "DELETE" }
      );
      setPeople(res.asset.people ?? []);
      onChanged({ kind: "asset", id: asset.id });
    } catch { /* leave the chip; the user can retry */ }
  };

  // Face crops for the people chips come from the People list when it is loaded
  // (it is, whenever the viewer can edit); otherwise the chip shows an initial.
  const faceFor = (person: GalleryPersonTag): string | null =>
    allPeople.find((p) => p.id === person.id)?.coverUrl ?? null;

  // The small "Edit" beside a section's heading, hidden while that field is open.
  const editLink = (field: EditableField, label: string) =>
    canEdit && editingField !== field ? (
      <Button
        variant="bare"
        className="lb-linkbtn"
        onClick={() => startEdit(field)}
        aria-label={t("gallery:lightbox.editAria", { label })}
        title={t("gallery:lightbox.editAria", { label })}
      >
        {t("gallery:lightbox.edit")}
      </Button>
    ) : null;

  const formActions = (
    <div className="gallery-info-form-actions">
      <Button variant="primary" compact type="submit" disabled={editBusy}>
        {editBusy ? t("gallery:common.saving") : t("gallery:common.save")}
      </Button>
      <Button variant="secondary" compact onClick={cancelEdit} disabled={editBusy}>{t("common:common.cancel")}</Button>
    </div>
  );

  // The inline form replacing a field's value while it's being edited.
  const editForm = (field: EditableField) => (
    <form
      className="gallery-info-form"
      onSubmit={(event) => { event.preventDefault(); void saveEdit(); }}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); cancelEdit(); } }}
    >
      {field === "description" ? (
        <textarea value={editValue} onChange={(event) => setEditValue(event.target.value)} rows={4} maxLength={5000} autoFocus aria-label={t("gallery:lightbox.labelDescription")} />
      ) : field === "takenAt" ? (
        <>
          <div className="gallery-info-date-grain">
            <select
              value={editPrecision}
              onChange={(event) => changeEditPrecision(event.target.value as TakenPrecision)}
              aria-label={t("gallery:date.precisionLabel")}
            >
              {TAKEN_PRECISIONS.map((precision) => (
                <option key={precision} value={precision}>{precisionLabel(precision)}</option>
              ))}
            </select>
            <label className="gallery-info-date-about">
              <input type="checkbox" checked={editApprox} onChange={(event) => setEditApprox(event.target.checked)} />
              <span>{t("gallery:date.aboutLabel")}</span>
            </label>
          </div>
          <input
            type={takenInputType(editPrecision)}
            value={editValue}
            onChange={(event) => setEditValue(event.target.value)}
            min={editPrecision === "year" || editPrecision === "decade" ? 1800 : undefined}
            max={editPrecision === "year" || editPrecision === "decade" ? new Date().getFullYear() : undefined}
            step={editPrecision === "decade" ? 10 : undefined}
            aria-label={t("gallery:lightbox.labelDate")}
            autoFocus
          />
        </>
      ) : field === "placeText" ? (
        <input
          value={editValue}
          onChange={(event) => setEditValue(event.target.value)}
          placeholder={t("gallery:lightbox.placePlaceholder")}
          maxLength={300}
          aria-label={t("gallery:lightbox.labelPlace")}
          autoFocus
        />
      ) : (
        <input
          value={editValue}
          onChange={(event) => setEditValue(event.target.value)}
          placeholder={t("gallery:lightbox.tagsPlaceholder")}
          aria-label={t("gallery:lightbox.labelTags")}
          autoFocus
        />
      )}
      {formActions}
      {editError && <span className="gallery-info-error">{editError}</span>}
    </form>
  );

  const tabs: { key: PanelTab; label: string }[] = [
    { key: "details", label: t("gallery:lightbox.tabDetails") },
    { key: "map", label: t("gallery:lightbox.tabMap") },
    { key: "file", label: t("gallery:lightbox.tabFile") }
  ];

  const takenText = formatTakenDate(asset, { withTime: true });
  // What a person wrote wins; the named place the pin falls in stands in when no
  // one has, and sits under it when someone has, since the two often differ ("the
  // dacha" · Ratomka, Minsk Region, Belarus).
  const namedPlace = asset.placeLabel ? formatPlaceLabel(asset.placeLabel) : "";
  const precision = asset.takenPrecision ?? "time";
  const kindLabel = asset.kind === "video" ? t("gallery:common.video") : asset.kind === "audio" ? t("gallery:common.audio") : t("gallery:common.photo");

  return (
    <aside className="gallery-lightbox-info" aria-label={t("gallery:lightbox.detailsHeading")}>
      <div className="lb-tabs" role="tablist">
        {tabs.map((item) => (
          <Button
            variant="tab"
            key={item.key}
            id={`lb-tab-${item.key}`}
            className="lb-tab"
            aria-selected={tab === item.key}
            aria-controls={`lb-pane-${item.key}`}
            onClick={() => setTab(item.key)}
          >
            {item.label}
          </Button>
        ))}
        <Button variant="bare" className="gallery-lightbox-action lb-close" onClick={onClose} aria-label={t("common:common.close")} title={t("common:common.close")}>
          <X size={18} aria-hidden="true" />
        </Button>
      </div>

      {tab === "details" && (
        <div className="lb-pane" role="tabpanel" id="lb-pane-details" aria-labelledby="lb-tab-details">
          <div className="lb-file-name">
            <FileText size={16} aria-hidden="true" />
            <span>{asset.title}</span>
          </div>

          <div className="lb-facts">
            {(asset.takenAt || canEdit) && (
              <>
                <Calendar size={18} aria-hidden="true" />
                <div className="lb-fact">
                  {editingField === "takenAt" ? editForm("takenAt") : (
                    <span>
                      {takenText || <span className="muted">—</span>}
                      {asset.takenAt && precision !== "time" && <span className="lb-pill">{precisionLabel(precision)}</span>}
                      {editLink("takenAt", t("gallery:lightbox.fieldDate"))}
                    </span>
                  )}
                </div>
              </>
            )}
            {(asset.placeText || asset.gps || canEdit) && (
              <>
                <MapPin size={18} aria-hidden="true" />
                <div className="lb-fact">
                  {editingField === "placeText" ? editForm("placeText") : (
                    <span>
                      {asset.placeText || namedPlace || <span className="muted">—</span>}
                      {editLink("placeText", t("gallery:lightbox.fieldPlace"))}
                      {asset.gps && (
                        <Button variant="bare" className="lb-linkbtn" onClick={() => setTab("map")}>{t("gallery:lightbox.tabMap")}</Button>
                      )}
                    </span>
                  )}
                  {editingField !== "placeText" && asset.placeText && namedPlace && <small className="lb-fact-sub">{namedPlace}</small>}
                </div>
              </>
            )}
          </div>

          {(people.length > 0 || canEdit) && (
            <section className="lb-sec">
              <div className="lb-sec-h"><Users size={18} aria-hidden="true" /><h3>{t("gallery:lightbox.labelPeople")}</h3></div>
              <div className="lb-chips">
                {people.map((person) => {
                  const face = faceFor(person);
                  const name = person.name || t("gallery:common.unnamed");
                  return (
                    <span key={person.id} className={`lb-chip${person.name ? "" : " is-unnamed"}`}>
                      <span className="lb-chip-face" aria-hidden="true">
                        {face ? <img src={face} alt="" /> : initial(person.name)}
                      </span>
                      {name}
                      {canEdit && (
                        <Button
                          variant="bare"
                          className="lb-chip-remove"
                          onClick={() => void removePerson(person.id)}
                          aria-label={t("gallery:lightbox.removePersonAria", { name: person.name || t("gallery:lightbox.personFallback") })}
                          title={t("gallery:lightbox.removePersonAria", { name: person.name || t("gallery:lightbox.personFallback") })}
                        >
                          <X size={12} aria-hidden="true" />
                        </Button>
                      )}
                    </span>
                  );
                })}
                {canEdit && !addingPerson && (
                  <Button variant="chip" className="lb-chip-add" onClick={() => setAddingPerson(true)} aria-label={t("gallery:lightbox.addPersonButton")} title={t("gallery:lightbox.addPersonButton")}>
                    <Plus size={16} aria-hidden="true" />
                  </Button>
                )}
              </div>
              {canEdit && addingPerson && (
                <form className="gallery-person-form" onSubmit={(event) => { event.preventDefault(); void addPerson(); }}>
                  <input
                    list="gallery-people-suggestions"
                    value={personName}
                    onChange={(event) => setPersonName(event.target.value)}
                    placeholder={t("gallery:common.name")}
                    maxLength={120}
                    aria-label={t("gallery:lightbox.addPersonButton")}
                    autoFocus
                  />
                  <datalist id="gallery-people-suggestions">
                    {allPeople.map((person) => <option key={person.id} value={person.name} />)}
                  </datalist>
                  <Button variant="secondary" compact type="submit" disabled={personBusy || !personName.trim()}>
                    {personBusy ? t("gallery:common.adding") : t("gallery:common.add")}
                  </Button>
                  <Button
                    variant="icon"
                    onClick={() => { setAddingPerson(false); setPersonName(""); setPersonError(""); }}
                    aria-label={t("common:common.cancel")}
                  >
                    <X size={14} aria-hidden="true" />
                  </Button>
                </form>
              )}
              {personError && <span className="gallery-person-error">{personError}</span>}
            </section>
          )}

          {(asset.tags.length > 0 || canEdit) && (
            <section className="lb-sec">
              <div className="lb-sec-h"><Tag size={18} aria-hidden="true" /><h3>{t("gallery:lightbox.labelTags")}</h3></div>
              <div className="lb-chips">
                {asset.tags.map((tag) => (
                  <span key={tag} className="lb-chip is-tag">
                    {tag}
                    {canEdit && (
                      <Button
                        variant="bare"
                        className="lb-chip-remove"
                        onClick={() => void removeTag(tag)}
                        disabled={editBusy}
                        aria-label={t("gallery:lightbox.removeTagAria", { tag })}
                        title={t("gallery:lightbox.removeTagAria", { tag })}
                      >
                        <X size={12} aria-hidden="true" />
                      </Button>
                    )}
                  </span>
                ))}
                {canEdit && editingField !== "tags" && (
                  <Button variant="chip" className="lb-chip-add" onClick={() => startEdit("tags")} aria-label={t("gallery:lightbox.addTagButton")} title={t("gallery:lightbox.addTagButton")}>
                    <Plus size={16} aria-hidden="true" />
                  </Button>
                )}
              </div>
              {editingField === "tags" && editForm("tags")}
              {editingField !== "tags" && editError && <span className="gallery-info-error">{editError}</span>}
            </section>
          )}

          {(asset.description || canEdit) && (
            <section className="lb-sec">
              <div className="lb-sec-h">
                <FileText size={18} aria-hidden="true" />
                <h3>{t("gallery:lightbox.labelDescription")}</h3>
                <span className="lb-grow" />
                {editLink("description", t("gallery:lightbox.fieldDescription"))}
              </div>
              {editingField === "description" ? editForm("description") : (
                <div className="lb-desc">{asset.description || <span className="muted">{t("gallery:lightbox.noDescription")}</span>}</div>
              )}
              {asset.reviewedAt && asset.reviewedBy && editingField !== "description" && (
                <span className="gallery-info-noted muted">
                  {t("gallery:lightbox.notedBy", { name: asset.reviewedBy, date: formatDate(asset.reviewedAt) })}
                </span>
              )}
            </section>
          )}

          {((voiceNotes?.length ?? 0) > 0 || canEdit) && (
            <section className="lb-sec">
              <VoiceNotes
                assetId={asset.id}
                notes={voiceNotes ?? []}
                canEdit={canEdit}
                onChanged={setVoiceNotes}
                thumbnailUrl={asset.coverUrl}
              />
            </section>
          )}

          <NotesSection entityType="gallery" entityId={asset.id} compact placeholder={t("gallery:lightbox.notePlaceholder")} />
        </div>
      )}

      {tab === "map" && (
        <div className="lb-pane" role="tabpanel" id="lb-pane-map" aria-labelledby="lb-tab-map">
          {editingField === "gps" ? (
            <div className="gallery-info-form">
              <GalleryPlaceSearch
                disabled={editBusy}
                onPick={(point, label, zoom) => {
                  setEditGps(point);
                  setEditGpsLabel(label);
                  setEditGpsFocus({ ...point, zoom, nonce: Date.now() });
                }}
              />
              <Suspense fallback={<div className="gallery-mini-map gallery-mini-map--loading" />}>
                <GalleryLocationPicker
                  value={editGps}
                  focus={editGpsFocus}
                  onChange={(next) => { setEditGps(next); setEditGpsLabel(""); }}
                />
              </Suspense>
              <span className="gallery-info-hint">
                {editGps
                  ? `${editGpsLabel ? `${editGpsLabel} — ` : ""}${editGps.lat.toFixed(5)}, ${editGps.lng.toFixed(5)}`
                  : t("gallery:lightbox.locationHint")}
              </span>
              <div className="gallery-info-form-actions">
                <Button variant="primary" compact onClick={() => { if (editGps) void saveLocation(editGps); }} disabled={editBusy || !editGps}>
                  {editBusy ? t("gallery:common.saving") : t("gallery:common.save")}
                </Button>
                <Button variant="secondary" compact onClick={cancelEdit} disabled={editBusy}>{t("common:common.cancel")}</Button>
                {asset.gps && (
                  <Button variant="danger" compact onClick={() => void saveLocation(null)} disabled={editBusy}>
                    {t("gallery:common.remove")}
                  </Button>
                )}
              </div>
              {editError && <span className="gallery-info-error">{editError}</span>}
            </div>
          ) : (
            <>
              {asset.gps ? (
                <Suspense fallback={<div className="gallery-mini-map gallery-mini-map--loading" />}>
                  <GalleryMiniMap lat={asset.gps.lat} lng={asset.gps.lng} title={asset.title} />
                </Suspense>
              ) : (
                <div className="lb-map-empty">{t("gallery:lightbox.noLocation")}</div>
              )}
              <div className="lb-facts">
                <MapPin size={18} aria-hidden="true" />
                <div className="lb-fact">
                  <span>{asset.placeText || namedPlace || <span className="muted">—</span>}</span>
                  {asset.placeText && namedPlace && <small className="lb-fact-sub">{namedPlace}</small>}
                  {asset.gps && (
                    <a
                      className="gallery-location-link"
                      href={`https://www.openstreetmap.org/?mlat=${asset.gps.lat}&mlon=${asset.gps.lng}#map=15/${asset.gps.lat}/${asset.gps.lng}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {asset.gps.lat.toFixed(5)}, {asset.gps.lng.toFixed(5)}
                    </a>
                  )}
                  {namedPlace && (
                    <small className="lb-fact-sub">
                      <Trans
                        t={t}
                        i18nKey="gallery:lightbox.placeNamesCredit"
                        components={{ lnk: <a href={PLACE_NAMES_CREDIT_URL} target="_blank" rel="noreferrer" /> }}
                      />
                    </small>
                  )}
                </div>
              </div>
              {canEdit && (
                <div className="gallery-info-form-actions">
                  <Button variant="secondary" compact onClick={() => startEdit("gps")}>
                    {asset.gps ? t("gallery:lightbox.moveLocation") : t("gallery:lightbox.setLocation")}
                  </Button>
                </div>
              )}
              <p className="gallery-info-hint">{t("gallery:lightbox.locationKept")}</p>
            </>
          )}
        </div>
      )}

      {tab === "file" && (
        <div className="lb-pane" role="tabpanel" id="lb-pane-file" aria-labelledby="lb-tab-file">
          <dl className="lb-file">
            <dt>{t("gallery:lightbox.labelName")}</dt><dd>{asset.title}</dd>
            <dt>{t("gallery:lightbox.labelType")}</dt><dd>{kindLabel}</dd>
            {asset.width != null && asset.height != null && (
              <><dt>{t("gallery:lightbox.labelDimensions")}</dt><dd>{asset.width} × {asset.height}</dd></>
            )}
            {(asset.kind === "video" || asset.kind === "audio") && asset.durationSeconds != null && (
              <><dt>{t("gallery:lightbox.labelDuration")}</dt><dd>{formatClock(asset.durationSeconds, CLIP_LENGTH)}</dd></>
            )}
            {asset.size != null && <><dt>{t("gallery:lightbox.labelSize")}</dt><dd>{formatBytes(asset.size)}</dd></>}
            {asset.camera && (asset.camera.make || asset.camera.model) && (
              <><dt>{t("gallery:lightbox.labelCamera")}</dt><dd>{[asset.camera.make, asset.camera.model].filter(Boolean).join(" ")}</dd></>
            )}
            {asset.addedAt && (
              <><dt>{t("gallery:lightbox.labelAdded")}</dt><dd>{formatDateTime(asset.addedAt, "medium")}</dd></>
            )}
            <dt>{t("gallery:lightbox.labelFolder")}</dt>
            <dd>
              {onOpenFolder ? (
                <Button
                  variant="bare"
                  className="gallery-info-link"
                  onClick={() => onOpenFolder(asset.folder)}
                  title={t("gallery:lightbox.openFolderTitle")}
                >
                  <FolderOpen size={14} aria-hidden="true" /> {asset.folder || "/"}
                </Button>
              ) : (asset.folder || "/")}
            </dd>
            {/* Which library holds it — the folder alone can't say when several
                libraries carry the same folder shapes (the duplicate pages exist
                because they do). */}
            {asset.libraryName && (
              <><dt>{t("gallery:lightbox.labelLibrary")}</dt><dd>{asset.libraryName}</dd></>
            )}
          </dl>

          {/* No rotate on a recording — there is nothing to turn (the server refuses too). */}
          {canEdit && asset.kind !== "audio" && (onRotate || onReplace) && (
            <section className="lb-sec">
              <div className="lb-sec-h"><h3>{t("gallery:lightbox.fileActions")}</h3></div>
              <div className="lb-actions">
                {onRotate && (
                  <>
                    <Button variant="secondary" compact onClick={() => onRotate("ccw")} disabled={rotateBusy}>
                      <RotateCcw size={14} aria-hidden="true" /> {t("gallery:lightbox.rotateLeft")}
                    </Button>
                    <Button variant="secondary" compact onClick={() => onRotate("cw")} disabled={rotateBusy}>
                      <RotateCw size={14} aria-hidden="true" /> {t("gallery:lightbox.rotateRight")}
                    </Button>
                  </>
                )}
                {onReplace && (
                  <Button variant="secondary" compact onClick={onReplace}>
                    <Replace size={14} aria-hidden="true" /> {t("gallery:replace.action")}
                  </Button>
                )}
              </div>
            </section>
          )}
        </div>
      )}
    </aside>
  );
}
