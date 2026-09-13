import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { MapPinned } from "lucide-react";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { MessageBox } from "../../../shared/MessageBox";
import { countryFlag } from "../../../shared/utils";
import { PLACE_NAMES_CREDIT_URL } from "../place-label";
import type { GalleryPlace } from "../types";

// Places (docs/map-approach-proposal.md, phase 2): the towns photos were taken in,
// grouped by country, most photographed first. A place is not a page of its own:
// opening one shows the Timeline filtered to it, so the filter chip that says so,
// Sort, View and Select all work the way they do anywhere else, and taking the
// chip away is the way back to everything.
export function PlacesView({
  scopeQuery,
  nameTerm,
  onOpen,
  onCount
}: {
  /** The libraries in scope, as the query string the other GET views send. */
  scopeQuery: string;
  /** The header's search box, lower-cased: narrows by place, region or country. */
  nameTerm: string;
  onOpen: (place: GalleryPlace) => void;
  /** How many places are listed, for the page subtitle. */
  onCount: (count: number) => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  const [places, setPlaces] = useState<GalleryPlace[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    setError("");
    api<{ places: GalleryPlace[] }>(`/api/library/gallery/places${scopeQuery ? `?${scopeQuery}` : ""}`)
      .then((payload) => { if (live) setPlaces(payload.places); })
      .catch((err) => { if (live) setError(err instanceof Error ? err.message : t("gallery:places.loadFailed")); });
    return () => { live = false; };
  }, [scopeQuery, t]);

  const shown = useMemo(() => (places ?? []).filter((place) => !nameTerm
    || [place.name, place.region ?? "", place.country].some((text) => text.toLowerCase().includes(nameTerm))), [places, nameTerm]);

  useEffect(() => { onCount(shown.length); }, [shown.length, onCount]);

  // Countries in order of how many photos were taken there; places inside each in
  // the server's order, which is already most photographed first.
  const countries = useMemo(() => {
    const byCode = new Map<string, { code: string; name: string; count: number; places: GalleryPlace[] }>();
    for (const place of shown) {
      const entry = byCode.get(place.countryCode) ?? { code: place.countryCode, name: place.country, count: 0, places: [] };
      entry.count += place.count;
      entry.places.push(place);
      byCode.set(place.countryCode, entry);
    }
    return [...byCode.values()].sort((a, b) => b.count - a.count);
  }, [shown]);

  if (error) return <MessageBox tone="error" title={t("gallery:places.loadFailed")}>{error}</MessageBox>;
  if (!places) return <p className="management-empty">{t("gallery:common.loading")}</p>;

  if (places.length === 0) {
    return (
      <div className="empty-state library-empty">
        <MapPinned size={48} aria-hidden="true" />
        <h2>{t("gallery:places.emptyTitle")}</h2>
        <p className="muted">{t("gallery:places.emptyBody")}</p>
      </div>
    );
  }

  return (
    <>
      {countries.map((country) => (
        <section key={country.code} className="gallery-places-country">
          <h2>
            <span aria-hidden="true">{countryFlag(country.code)}</span> {country.name}
            <small>{t("gallery:common.counts.photo", { count: country.count })}</small>
          </h2>
          <div className="gallery-folder-grid">
            {country.places.map((place) => (
              <Button variant="tile" key={place.id} className="gallery-folder-tile" onClick={() => onOpen(place)}>
                <span className="gallery-folder-thumb">
                  {place.cover?.coverUrl
                    ? (
                      <img
                        src={place.cover.coverUrl}
                        alt=""
                        loading="lazy"
                        style={place.cover.faceFocus ? { objectPosition: `${place.cover.faceFocus.x}% ${place.cover.faceFocus.y}%` } : undefined}
                      />
                    )
                    : <MapPinned size={28} aria-hidden="true" />}
                </span>
                <strong>{place.name}</strong>
                <small>
                  {[place.region, t("gallery:common.counts.photo", { count: place.count })].filter(Boolean).join(" · ")}
                </small>
              </Button>
            ))}
          </div>
        </section>
      ))}
      {shown.length === 0 && (
        <div className="empty-state library-empty">
          <MapPinned size={48} aria-hidden="true" />
          <h2>{t("gallery:places.noMatchTitle")}</h2>
          <p className="muted">{t("gallery:places.noMatchBody")}</p>
        </div>
      )}
      <p className="muted gallery-places-credit">
        {t("gallery:places.creditBefore")} <a href={PLACE_NAMES_CREDIT_URL} target="_blank" rel="noreferrer">GeoNames</a>
      </p>
    </>
  );
}
