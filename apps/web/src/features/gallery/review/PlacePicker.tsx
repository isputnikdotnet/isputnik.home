import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Globe, MapPin, X } from "lucide-react";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";

// "Where?" in Review mode: the place in her own words, and — when the words name
// a town — a pin, so the photo shows up on the map too.
//
// Towns are offered as she types from the server's places database (Maps → Named
// places), which is offline. The online lookup the lightbox's map uses is only a
// button, one request per press: OpenStreetMap's policy forbids search-as-you-type
// against it, and pressing it is also the moment her words leave the house.
//
// A photo that already has a pin (from the camera, or set by hand) is never
// re-pinned from here; its words can still change.

export interface PlacePin {
  lat: number;
  lng: number;
  /** The found place's full name, shown beside the pin. */
  label: string;
}

interface Hit {
  label: string;
  lat: number;
  lng: number;
}

const SUGGEST_DELAY_MS = 250;

/** What goes in the text field for a found place: "Ratomka, Minsk District, Minsk
 *  Region, Belarus" reads as "Ratomka, Belarus" — the pin keeps the rest. */
export function shortPlaceLabel(label: string): string {
  const parts = label.split(",").map((part) => part.trim()).filter(Boolean);
  return parts.length > 2 ? `${parts[0]}, ${parts[parts.length - 1]}` : parts.join(", ");
}

export function PlacePicker({
  value,
  pin,
  alreadyPinned,
  onChange,
  disabled
}: {
  value: string;
  pin: PlacePin | null;
  /** The photo has its own location; nothing here will move it. */
  alreadyPinned: boolean;
  onChange: (place: string, pin: PlacePin | null) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("galleryReview");
  // What she typed last (not a value set by a pick or a chip) — the only thing
  // worth suggesting for.
  const [typed, setTyped] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [online, setOnline] = useState<{ query: string; state: "busy" | "done" | "error" } | null>(null);
  const request = useRef(0);

  const query = typed.trim();
  // Suggestions belong to what is in the field: a chip or Same as the last one
  // that replaced her typing takes them away.
  const canPin = !alreadyPinned && !disabled && value.trim() === query;

  // Offline towns, a moment after she stops typing. A late answer for an older
  // query is dropped.
  useEffect(() => {
    if (!canPin || query.length < 2) return;
    const id = ++request.current;
    const timer = window.setTimeout(() => {
      api<{ available: boolean; results: Hit[] }>(`/api/library/gallery/place-suggest?q=${encodeURIComponent(query)}`)
        .then((payload) => { if (request.current === id) setHits(payload.results ?? []); })
        .catch(() => { if (request.current === id) setHits([]); });
    }, SUGGEST_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [query, canPin]);

  const searchOnline = async () => {
    const id = ++request.current;
    setOnline({ query, state: "busy" });
    try {
      const payload = await api<{ results: Hit[] }>(`/api/library/gallery/geocode?q=${encodeURIComponent(query)}`);
      if (request.current !== id) return;
      setHits(payload.results ?? []);
      setOnline({ query, state: "done" });
    } catch {
      if (request.current === id) setOnline({ query, state: "error" });
    }
  };

  const pick = (hit: Hit) => {
    request.current += 1;
    setTyped("");
    setHits([]);
    setOnline(null);
    onChange(shortPlaceLabel(hit.label), { lat: hit.lat, lng: hit.lng, label: hit.label });
  };

  const showHits = canPin && query.length >= 2 && hits.length > 0;
  const offerOnline = canPin && query.length >= 3 && !(online?.query === query && online.state === "done");

  return (
    <div className="review-place">
      <input
        className="review-input"
        value={value}
        onChange={(event) => {
          setTyped(event.target.value);
          if (event.target.value.trim().length < 2) setHits([]);
          if (online && online.query !== event.target.value.trim()) setOnline(null);
          onChange(event.target.value, pin);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && (hits.length > 0 || typed)) { event.stopPropagation(); setTyped(""); setHits([]); }
        }}
        placeholder={t("where.placeholder")}
        maxLength={300}
        disabled={disabled}
        aria-label={t("where.heading")}
      />

      {canPin && (showHits || offerOnline || online?.state === "error" || (online?.state === "done" && hits.length === 0)) && (
        <div className="review-place-hits" role="group" aria-label={t("where.matchesAria")}>
          {showHits && hits.map((hit) => (
            <Button key={`${hit.lat},${hit.lng},${hit.label}`} variant="bare" className="review-place-hit" onClick={() => pick(hit)}>
              <MapPin size={18} aria-hidden="true" />
              <span>{hit.label}</span>
            </Button>
          ))}
          {online?.state === "done" && hits.length === 0 && <p className="review-hint">{t("where.onlineNone", { text: online.query })}</p>}
          {online?.state === "error" && <p className="review-hint">{t("where.onlineError")}</p>}
          {offerOnline && (
            <Button
              variant="text"
              className="review-place-online"
              onClick={() => void searchOnline()}
              disabled={online?.state === "busy"}
              title={t("where.onlineTitle")}
            >
              <Globe size={16} aria-hidden="true" />
              <span>{online?.state === "busy" ? t("where.onlineBusy") : t("where.online", { text: query })}</span>
            </Button>
          )}
        </div>
      )}

      {pin && !alreadyPinned && (
        <div className="review-place-pin">
          <MapPin size={18} aria-hidden="true" />
          <span>{t("where.pinned", { label: pin.label })}</span>
          <Button
            variant="bare"
            className="review-chip-remove"
            onClick={() => onChange(value, null)}
            disabled={disabled}
            aria-label={t("where.unpin")}
            title={t("where.unpin")}
          >
            <X size={16} aria-hidden="true" />
          </Button>
        </div>
      )}
      {alreadyPinned && <p className="review-hint review-place-already"><MapPin size={15} aria-hidden="true" /> {t("where.alreadyPinned")}</p>}
    </div>
  );
}
