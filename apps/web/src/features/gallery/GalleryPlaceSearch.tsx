import { useState } from "react";
import { MapPin, Search } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";

interface PlaceHit { label: string; lat: number; lng: number }

// "53.9, 27.56" (or "53.9 27.56") typed into the search box is a location, not a
// place name — resolve it locally instead of asking the geocoder.
function parseCoordinates(value: string): { lat: number; lng: number } | null {
  const match = value.trim().match(/^(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

// Find a spot by name instead of hunting for it on a world map. Shared by the
// bulk "Set location" dialog and the lightbox Info panel, which style it through
// their own scopes — this only owns the query, the hit list, and the pick.
export function GalleryPlaceSearch({
  onPick,
  disabled = false,
  autoFocus = false
}: {
  onPick: (point: { lat: number; lng: number }, label: string, zoom?: number) => void;
  disabled?: boolean;
  /** On in the dialog, where the box is the first thing you meet; off in the
   *  lightbox panel, which must not steal focus from the photo's key handling. */
  autoFocus?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<PlaceHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");

  const runSearch = async () => {
    const q = search.trim();
    if (q.length < 2) return;

    const coords = parseCoordinates(q);
    if (coords) {
      setHits(null);
      setError("");
      onPick(coords, `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`, 15);
      return;
    }

    setSearching(true);
    setError("");
    try {
      const payload = await api<{ results: PlaceHit[] }>(`/api/library/gallery/geocode?q=${encodeURIComponent(q)}`);
      setHits(payload.results);
    } catch (err) {
      setHits(null);
      setError(err instanceof Error ? err.message : "The place lookup failed.");
    } finally {
      setSearching(false);
    }
  };

  return (
    <>
      {/* The dialog host is itself a <form>, so a nested one isn't legal: Enter is
          handled by hand, and must not fall through to that form's submit. */}
      <div className="gallery-place-search">
        <label>
          <span className="sr-only">Search for a place, address, postcode, or Plus Code</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              void runSearch();
            }}
            placeholder="Place, address, Plus Code, or 53.9, 27.56"
            disabled={disabled}
            autoFocus={autoFocus}
          />
        </label>
        <Button
          variant="secondary"
          compact
          onClick={() => void runSearch()}
          disabled={search.trim().length < 2 || searching || disabled}
        >
          <Search size={15} aria-hidden="true" /> {searching ? "Searching…" : "Search"}
        </Button>
      </div>

      {error && <span className="gallery-place-search-error">{error}</span>}

      {hits !== null && (
        hits.length > 0 ? (
          <ul className="gallery-place-results">
            {hits.map((hit) => (
              <li key={`${hit.lat},${hit.lng},${hit.label}`}>
                <button type="button" onClick={() => { onPick(hit, hit.label); setHits(null); }} disabled={disabled}>
                  <MapPin size={15} aria-hidden="true" />
                  <span>{hit.label}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <span className="gallery-place-search-empty">
            Nothing found for “{search.trim()}”. Try a broader name, or drop the pin yourself.
          </span>
        )
      )}
    </>
  );
}
