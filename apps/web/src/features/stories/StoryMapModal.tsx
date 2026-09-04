import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, MapPin, X } from "lucide-react";
import { Modal } from "../../shared/Modal";
import { Button } from "../../shared/Button";
import { GalleryPlaceSearch } from "../gallery/GalleryPlaceSearch";
import { StoryRoutePicker } from "./StoryRoutePicker";
import type { StoryMapPoint } from "./types";

// Place a map block: search for a place (or drop a pin), name it, done — and if
// the block is about a journey rather than a spot, keep adding stops and the
// map draws the route between them, in the order they are listed.
//
// One stop is exactly the old single-pin map, which is why there is no "route"
// block kind to choose between: the same block grows into one.
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
  const { t } = useTranslation(["common", "stories"]);
  // Blocks written before routes carry their one place in lat/lng alone, so
  // they open as a route of one rather than as an empty map.
  const [stops, setStops] = useState<StoryMapPoint[]>(() => {
    if (!initial) return [];
    if (initial.points.length > 0) return initial.points;
    return [{ lat: initial.lat, lng: initial.lng, label: initial.label }];
  });
  const addStop = (stop: StoryMapPoint) => {
    setStops((current) => (single ? [stop] : [...current, stop]));
  };
  const [zoom, setZoom] = useState(initial?.zoom ?? 12);
  const [focus, setFocus] = useState<{ lat: number; lng: number; zoom?: number; nonce: number } | null>(null);

  const editStop = (index: number, patch: Partial<StoryMapPoint>) => {
    setStops((current) => current.map((stop, at) => (at === index ? { ...stop, ...patch } : stop)));
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
    onSave({ lat: first.lat, lng: first.lng, zoom, label: first.label, points: stops });
  };

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

        <StoryRoutePicker
          points={stops}
          onAdd={(point) => addStop({ ...point, label: null })}
          onMove={(index, point) => editStop(index, point)}
          focus={focus}
        />

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
                  <li key={`${stop.lat},${stop.lng},${index}`}>
                    <span className="story-route-index" aria-hidden="true">{index + 1}</span>
                    <input
                      value={stop.label ?? ""}
                      onChange={(event) => editStop(index, { label: event.target.value })}
                      placeholder={t("stories:map.labelPlaceholder")}
                      aria-label={t("stories:map.stopName", { number: index + 1 })}
                      maxLength={200}
                    />
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
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}

        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose}>{t("common:common.cancel")}</Button>
          <Button variant="primary" type="submit" disabled={stops.length === 0}>
            {initial ? t("stories:actions.save") : t("stories:map.addBlock")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
