import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, MapPin, Route, Trash2, X } from "lucide-react";
import { Modal } from "../../shared/Modal";
import { Button } from "../../shared/Button";
import { GalleryPlaceSearch } from "../gallery/GalleryPlaceSearch";
import { StoryRoutePicker } from "./StoryRoutePicker";
import { routeDistanceKm } from "./story-route";
import { TRAVEL_MODES, type StoryMapPoint, type TravelMode } from "./types";

// Place a map block: search for a place (or drop a pin), name it, done — and if
// the block is about a journey rather than a spot, keep adding stops and the
// map draws the route between them, in the order they are listed.
//
// One stop is exactly the old single-pin map, which is why there is no "route"
// block kind to choose between: the same block grows into one.
//
// Two columns: the words on the left (search, then the stops in travel order),
// the map on the right. Only the left column scrolls, so a long itinerary never
// pushes the map — or the search results — out of the dialog.
export function StoryMapModal({
  initial,
  onSave,
  onClose,
  single = false
}: {
  initial: { lat: number; lng: number; zoom: number | null; label: string | null; points: StoryMapPoint[] } | null;
  /** A chapter is somewhere, not on its way somewhere: its pin uses the same
   *  dialog with the route trimmed down to one stop, which a new pick moves. */
  single?: boolean;
  onSave: (value: {
    lat: number;
    lng: number;
    zoom: number;
    label: string | null;
    points: StoryMapPoint[];
  }) => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation(["common", "stories"]);
  // Blocks written before routes carry their one place in lat/lng alone, so
  // they open as a route of one rather than as an empty map.
  const [stops, setStops] = useState<StoryMapPoint[]>(() => {
    if (!initial) return [];
    if (initial.points.length > 0) return initial.points;
    return [{ lat: initial.lat, lng: initial.lng, label: initial.label, mode: null, geometry: null }];
  });
  const addStop = (stop: Omit<StoryMapPoint, "mode" | "geometry">) => {
    setStops((current) => {
      if (single) return [{ ...stop, mode: null, geometry: null }];
      // Driving is the common case between two towns, so the first leg starts
      // there rather than with nothing said; every later leg inherits.
      const mode = current.length === 0 ? null : current[current.length - 1].mode ?? "drive";
      return [...current, { ...stop, mode, geometry: null }];
    });
  };
  const [zoom, setZoom] = useState(initial?.zoom ?? 12);
  const [focus, setFocus] = useState<{ lat: number; lng: number; zoom?: number; nonce: number } | null>(null);

  const editStop = (index: number, patch: Partial<StoryMapPoint>) => {
    setStops((current) => current.map((stop, at) => (at === index ? { ...stop, ...patch } : stop)));
  };

  const setMode = (index: number, mode: TravelMode | null) => {
    // The stored line belongs to the old mode: a drive's roads are not a walk's.
    editStop(index, { mode, geometry: null });
  };

  const swapStops = (index: number, target: number) => {
    setStops((current) => {
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const submit = () => {
    if (stops.length === 0) return;
    // The first stop stays the block's own lat/lng: it frames the map, and it
    // is what anything that predates routes reads.
    const [first] = stops;
    // Geometry is never sent: the server derives each leg's line from the stops
    // and the modes, so the browser cannot draw a journey somewhere it wasn't.
    onSave({
      lat: first.lat,
      lng: first.lng,
      zoom,
      label: first.label,
      points: stops.map((stop) => ({ ...stop, geometry: null }))
    });
  };

  // As the crow flies: the real roads are drawn by the server after saving, so
  // this is a planning figure, and it is worded as one.
  const distanceKm = stops.length > 1 ? routeDistanceKm(stops) : 0;
  const distanceLabel = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: distanceKm < 10 ? 1 : 0 })
    .format(distanceKm);

  return (
    <Modal
      variant="panel"
      title={initial ? t("stories:map.editTitle") : t("stories:map.addTitle")}
      icon={<MapPin size={20} />}
      className="story-map-picker-modal"
      subtitle={single ? t("stories:map.introPoint") : t("stories:map.intro")}
      onClose={onClose}
      onSubmit={(event) => { event.preventDefault(); submit(); }}
    >
      <div className="modal-tab-content story-map-modal">
        <aside className="story-map-side">
          <div className="story-map-search">
            <GalleryPlaceSearch
              autoFocus
              onPick={(next, name, nextZoom) => {
                setZoom(nextZoom ?? 12);
                setFocus({ ...next, zoom: nextZoom, nonce: Date.now() });
                // The place's own name is almost always the caption wanted; an
                // author who disagrees just types over it in the list below.
                addStop({ lat: next.lat, lng: next.lng, label: name });
              }}
            />
          </div>

          {single ? (
            <label className="field">
              <span>{t("stories:map.labelField")} <small className="muted">{t("stories:fields.optional")}</small></span>
              <input
                value={stops[0]?.label ?? ""}
                onChange={(event) => editStop(0, { label: event.target.value })}
                placeholder={t("stories:map.labelPlaceholder")}
                disabled={stops.length === 0}
                maxLength={200}
              />
            </label>
          ) : (
            <section className="story-route-stops-section">
              <h3>{t("stories:map.stopsHeading", { count: stops.length })}</h3>
              {stops.length === 0 ? (
                <p className="story-route-empty muted">{t("stories:map.stopsEmpty")}</p>
              ) : (
                <ol className="story-route-stops">
                  {stops.map((stop, index) => (
                    <li key={`${stop.lat},${stop.lng},${index}`} className="story-route-stop">
                      <span className="story-route-index" aria-hidden="true">{index + 1}</span>
                      <input
                        className="story-route-stop-name"
                        value={stop.label ?? ""}
                        onChange={(event) => editStop(index, { label: event.target.value })}
                        placeholder={t("stories:map.labelPlaceholder")}
                        aria-label={t("stories:map.stopName", { number: index + 1 })}
                        maxLength={200}
                      />
                      <div className="story-route-stop-tools">
                        <Button
                          variant="icon"
                          compact
                          aria-label={t("stories:map.stopUp", { number: index + 1 })}
                          title={t("stories:map.stopUp", { number: index + 1 })}
                          disabled={index === 0}
                          onClick={() => swapStops(index, index - 1)}
                        >
                          <ChevronUp size={15} aria-hidden="true" />
                        </Button>
                        <Button
                          variant="icon"
                          compact
                          aria-label={t("stories:map.stopDown", { number: index + 1 })}
                          title={t("stories:map.stopDown", { number: index + 1 })}
                          disabled={index === stops.length - 1}
                          onClick={() => swapStops(index, index + 1)}
                        >
                          <ChevronDown size={15} aria-hidden="true" />
                        </Button>
                        <Button
                          variant="icon"
                          compact
                          danger
                          aria-label={t("stories:map.stopRemove", { number: index + 1 })}
                          title={t("stories:map.stopRemove", { number: index + 1 })}
                          onClick={() => setStops((current) => current.filter((_, at) => at !== index))}
                        >
                          <X size={15} aria-hidden="true" />
                        </Button>
                      </div>
                      {index > 0 && (
                        <select
                          className="story-route-mode"
                          value={stop.mode ?? ""}
                          onChange={(event) => setMode(index, (event.target.value || null) as TravelMode | null)}
                          aria-label={t("stories:map.stopMode", { number: index + 1 })}
                          title={t("stories:map.stopMode", { number: index + 1 })}
                        >
                          <option value="">{t("stories:map.modeNone")}</option>
                          {TRAVEL_MODES.map((mode) => (
                            <option key={mode} value={mode}>{t(`stories:map.modes.${mode}` as "stories:map.modes.walk")}</option>
                          ))}
                        </select>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </section>
          )}
        </aside>

        <div className="story-map-main">
          <StoryRoutePicker
            points={stops}
            onAdd={(point) => addStop({ ...point, label: null })}
            onMove={(index, point) => editStop(index, point)}
            focus={focus}
          />
          {!single && stops.length > 1 && (
            <div className="story-route-summary">
              <Route size={20} aria-hidden="true" />
              <div>
                <strong>{t("stories:map.summaryHeading")}</strong>
                <p>{t("stories:map.summaryDistance", { count: stops.length, distance: distanceLabel })}</p>
                <small className="muted">{t("stories:map.roadsNote")}</small>
              </div>
            </div>
          )}
        </div>

        <div className="modal-actions story-map-actions">
          {!single && (
            <Button
              variant="text"
              danger
              className="story-map-clear"
              disabled={stops.length === 0}
              onClick={() => setStops([])}
            >
              <Trash2 size={15} aria-hidden="true" /> {t("stories:map.clearMap")}
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>{t("common:common.cancel")}</Button>
          <Button variant="primary" type="submit" disabled={stops.length === 0}>
            {initial ? t("stories:actions.save") : t("stories:map.addBlock")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
