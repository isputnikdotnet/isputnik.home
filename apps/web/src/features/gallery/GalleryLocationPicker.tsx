import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { MapView } from "../../shared/map";
import type { LatLng, MapShapes, MapViewCommand } from "../../shared/map";

// Click-to-place location picker for the lightbox Info panel: click the map (or
// drag the pin) to choose where a photo was taken. Unlike the read-only mini
// map, scroll-wheel zoom stays on — picking a point is a deliberate interaction
// that needs zooming.
export function GalleryLocationPicker({
  value,
  onChange,
  focus
}: {
  value: { lat: number; lng: number } | null;
  onChange: (next: { lat: number; lng: number }) => void;
  /** Recentre + drop the pin from outside the map (a place-search result). The
   *  nonce is what triggers it, so picking the same place twice still moves the
   *  view back, and a click on the map never re-fires this. */
  focus?: { lat: number; lng: number; zoom?: number; nonce: number } | null;
}) {
  const { t } = useTranslation(["common", "gallery"]);

  // Where the pin is now. `value` only SEEDS it: once the map is open the pin
  // belongs to this component, and the parent hears about it through onChange.
  const [pin, setPin] = useState(value);

  const options = useMemo(
    () => ({
      // With no starting point, show the world and let the user zoom in.
      center: (value ? [value.lat, value.lng] : [25, 10]) as LatLng,
      zoom: value ? 14 : 1
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const shapes = useMemo<MapShapes>(
    () => ({
      markers: pin
        ? [{
            id: "pin",
            lat: pin.lat,
            lng: pin.lng,
            className: "gallery-mini-marker",
            html: '<span class="gallery-mini-pin"></span>',
            size: [18, 18] as [number, number],
            draggable: true
          }]
        : []
    }),
    [pin]
  );

  const [view, setView] = useState<MapViewCommand | null>(null);

  // A search result: move the view there and put the pin on it.
  useEffect(() => {
    if (!focus) return;
    setPin({ lat: focus.lat, lng: focus.lng });
    setView({ kind: "center", center: [focus.lat, focus.lng], zoom: focus.zoom ?? 13 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  // A click places the pin if there isn't one and moves it if there is; a drag
  // says the same thing more precisely. Both are the user choosing a point.
  const place = (point: { lat: number; lng: number }) => {
    setPin(point);
    onChange(point);
  };

  return (
    <MapView
      options={options}
      shapes={shapes}
      view={view}
      onMapClick={place}
      onMarkerDragEnd={(_id, point) => place(point)}
      className="gallery-mini-map gallery-location-picker"
      ariaLabel={t("gallery:locationPicker.aria")}
    />
  );
}
