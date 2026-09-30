import { useState } from "react";
import { useTranslation } from "react-i18next";
import { BookmarkPlus, History, Home, MapPin } from "lucide-react";
import { Button } from "../../shared/Button";
import { SavePlaceModal } from "./SavePlaceModal";
import { SavedPlacesModal } from "./SavedPlacesModal";
import { distanceKm, recentPlaceName, savedPlaceAt, savedPlaceName, SAME_PLACE_KM, type Point, type SavedPlacesState } from "./savedPlaces";

/** Chips shown before the rest wait in Manage places and in the search. */
const CHIPS_SHOWN = 8;
/** Close enough to read the house, not the street. */
const PLACE_ZOOM = 16;

// The places photos are pinned to again and again, one click each: the
// household's saved places, most used first, then this person's own recent pins.
// Under them, "Save this place" for a pin that is not a saved place yet. Rendered
// by GalleryPlaceSearch, so the bulk dialog and the lightbox get the same row.
export function GallerySavedPlaces({
  saved,
  pin,
  pinLabel,
  disabled,
  onPick
}: {
  saved: SavedPlacesState;
  /** Where the pin is now — what "Save this place" would save. */
  pin: Point | null;
  /** What the search called that point, offered as the name to save it under. */
  pinLabel: string;
  disabled: boolean;
  onPick: (point: Point, label: string, zoom?: number) => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  const [dialog, setDialog] = useState<"save" | "manage" | null>(null);

  const { canSave, places, recent } = saved;
  if (!canSave) return null;

  const homeName = t("gallery:savedPlaces.home");
  const standingOn = savedPlaceAt(places, pin);
  const chips = places.slice(0, CHIPS_SHOWN);
  const isRecentPin = (point: Point) => Boolean(pin) && distanceKm(point, pin!) <= SAME_PLACE_KM;

  // An open dialog keeps the row: deleting the last place must not close Manage.
  if (chips.length === 0 && recent.length === 0 && !pin && !dialog) return null;

  return (
    <div className="gallery-saved-places">
      {(chips.length > 0 || recent.length > 0) && (
        <div className="gallery-saved-chips" role="group" aria-label={t("gallery:savedPlaces.chipsAria")}>
          {chips.map((place) => {
            const name = savedPlaceName(place, homeName);
            return (
              <Button
                key={place.id}
                variant="chip"
                className="gallery-place-chip"
                aria-pressed={standingOn?.id === place.id}
                disabled={disabled}
                title={name}
                onClick={() => onPick({ lat: place.lat, lng: place.lng }, name, PLACE_ZOOM)}
              >
                {place.home ? <Home size={14} aria-hidden="true" /> : <MapPin size={14} aria-hidden="true" />}
                <span>{name}</span>
              </Button>
            );
          })}
          {recent.map((place) => {
            const name = recentPlaceName(place);
            return (
              <Button
                key={`${place.lat},${place.lng}`}
                variant="chip"
                className="gallery-place-chip gallery-place-chip--recent"
                aria-pressed={!standingOn && isRecentPin(place)}
                disabled={disabled}
                title={t("gallery:savedPlaces.recentTitle", { place: name.full })}
                onClick={() => onPick({ lat: place.lat, lng: place.lng }, name.full, PLACE_ZOOM)}
              >
                <History size={14} aria-hidden="true" />
                <span>{name.short}</span>
              </Button>
            );
          })}
        </div>
      )}

      {((pin && !standingOn) || places.length > 0) && (
        <div className="gallery-saved-actions">
          {pin && !standingOn && (
            <Button variant="text" compact disabled={disabled} onClick={() => setDialog("save")}>
              <BookmarkPlus size={15} aria-hidden="true" /> {t("gallery:savedPlaces.save")}
            </Button>
          )}
          {places.length > 0 && (
            <Button variant="text" compact disabled={disabled} onClick={() => setDialog("manage")}>
              {t("gallery:savedPlaces.manage")}
            </Button>
          )}
        </div>
      )}

      {dialog === "save" && pin && (
        <SavePlaceModal
          point={pin}
          suggestedName={pinLabel}
          onClose={() => setDialog(null)}
          onSaved={() => { setDialog(null); saved.reload(); }}
        />
      )}
      {dialog === "manage" && (
        <SavedPlacesModal
          places={places}
          onClose={() => setDialog(null)}
          onChanged={saved.reload}
        />
      )}
    </div>
  );
}
