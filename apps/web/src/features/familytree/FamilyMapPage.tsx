import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Baby, CalendarClock, Cross, Heart, MapPin, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { followRoute, navigate } from "../../router";
import { Button } from "../../shared/Button";
import { LibraryPageHeader } from "../../shared/LibraryPageHeader";
import { MapView } from "../../shared/map";
import type { LatLng, MapShapes, MapViewCommand } from "../../shared/map";
import { MessageBox } from "../../shared/MessageBox";
import { SectionNav } from "../../shared/SectionNav";
import { formatPartialDate, formatPartialDateRange } from "../../shared/utils";
import { PersonAvatar } from "./PersonAvatar";
import { familyNavProps } from "./sectionNavItems";
import { eventTypeLabel, personMatchesSearch, type FamilyEvent, type FamilyPerson, type FamilyTree } from "./types";

// Where the family's lives happened: every pinned birth, death, marriage and life
// event on one map. Entries at the same spot are one pin (a count when there is
// more than one), and the list beside the map is the way in — every place, most
// eventful first; choosing one flies there and lists what happened there, oldest
// first, with the people linked to their profiles.
//
// Only places picked from the place search have a pin, so the page says how many
// are still words alone rather than guessing coordinates from text.
//
// `personId` (from ?person=) narrows the map to one person — the profile's
// "Show on map" — and joins their dated places in order, a life's path.

export type FamilyMapKind = "birth" | "death" | "marriage" | "event";

export interface FamilyMapEntry {
  id: string;
  kind: FamilyMapKind;
  personIds: string[];
  place: string;
  lat: number;
  lng: number;
  date: string | null;
  endDate: string | null;
  eventType: FamilyEvent["type"] | null;
  label: string | null;
}

interface MapPlace {
  key: string;
  lat: number;
  lng: number;
  label: string;
  entries: FamilyMapEntry[];
  kind: FamilyMapKind | "mixed";
}

const KINDS: FamilyMapKind[] = ["birth", "marriage", "event", "death"];

const KIND_ICONS = { birth: Baby, marriage: Heart, event: CalendarClock, death: Cross } as const;

/** Entries within a few metres are one pin: the same town picked twice gives the
 *  same coordinates, and nearby-but-different places stay apart. */
function placeKey(entry: Pick<FamilyMapEntry, "lat" | "lng">): string {
  return `${entry.lat.toFixed(4)},${entry.lng.toFixed(4)}`;
}

function groupPlaces(entries: FamilyMapEntry[]): MapPlace[] {
  const byKey = new Map<string, FamilyMapEntry[]>();
  for (const entry of entries) {
    const key = placeKey(entry);
    const list = byKey.get(key);
    if (list) list.push(entry);
    else byKey.set(key, [entry]);
  }
  return [...byKey.entries()].map(([key, list]): MapPlace => {
    // The name the place is written with most often is the one it goes by.
    const counts = new Map<string, number>();
    for (const entry of list) counts.set(entry.place, (counts.get(entry.place) ?? 0) + 1);
    const label = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    const kinds = new Set(list.map((entry) => entry.kind));
    return {
      key,
      lat: list[0].lat,
      lng: list[0].lng,
      label,
      entries: list,
      kind: kinds.size === 1 ? list[0].kind : "mixed"
    };
  }).sort((a, b) => b.entries.length - a.entries.length || a.label.localeCompare(b.label));
}

export function FamilyMapPage({ personId }: { personId: string | null }) {
  const { t } = useTranslation(["common", "family"]);
  const [persons, setPersons] = useState<Map<string, FamilyPerson>>(new Map());
  const [entries, setEntries] = useState<FamilyMapEntry[] | null>(null);
  const [unpinned, setUnpinned] = useState(0);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [kinds, setKinds] = useState<Set<FamilyMapKind>>(() => new Set(KINDS));
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [view, setView] = useState<MapViewCommand | null>(null);

  useEffect(() => {
    Promise.all([
      api<FamilyTree>("/api/family-tree/tree"),
      api<{ entries: FamilyMapEntry[]; unpinned: number }>("/api/family-tree/map")
    ])
      .then(([tree, map]) => {
        setPersons(new Map(tree.persons.map((person) => [person.id, person])));
        setEntries(map.entries);
        setUnpinned(map.unpinned);
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("family:map.errors.load")));
  }, [t]);

  const focus = personId ? persons.get(personId) ?? null : null;
  const term = search.trim().toLocaleLowerCase();

  const shownEntries = useMemo(() => (entries ?? []).filter((entry) =>
    kinds.has(entry.kind)
    && (!personId || entry.personIds.includes(personId))
    && (!term || entry.personIds.some((id) => {
      const person = persons.get(id);
      return person ? personMatchesSearch(person, term) : false;
    }))
  ), [entries, kinds, personId, term, persons]);

  const places = useMemo(() => groupPlaces(shownEntries), [shownEntries]);
  const selected = places.find((place) => place.key === selectedKey) ?? null;

  // A life's path: the focused person's dated places in order, one leg per move.
  const path = useMemo<LatLng[]>(() => {
    if (!personId) return [];
    const points: LatLng[] = [];
    for (const entry of shownEntries) {
      if (!entry.date) continue;
      const last = points[points.length - 1];
      if (last && placeKey({ lat: last[0], lng: last[1] }) === placeKey(entry)) continue;
      points.push([entry.lat, entry.lng]);
    }
    return points.length > 1 ? points : [];
  }, [personId, shownEntries]);

  // Reframe whenever what is shown changes — the pins ARE the answer to the filters.
  const framing = places.map((place) => place.key).join("|");
  const framed = useRef(false);
  useEffect(() => {
    if (places.length === 0) return;
    setView({
      kind: "fit",
      points: places.map((place) => [place.lat, place.lng] as LatLng),
      pad: 0.2,
      maxZoom: 9,
      single: { zoom: 9 },
      // The first frame jumps: there is no earlier view to glide from, and an
      // animation started in a background tab never finishes.
      animate: framed.current
    });
    framed.current = true;
    // `framing` stands for `places`: the same set of pins must not refit the map
    // the reader has since moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [framing]);

  useEffect(() => {
    if (selectedKey && !places.some((place) => place.key === selectedKey)) setSelectedKey(null);
  }, [places, selectedKey]);

  const options = useMemo(() => ({
    center: [30, 10] as LatLng,
    zoom: 2,
    worldCopyJump: true,
    cluster: true,
    clusterRadius: 44
  }), []);

  const shapes = useMemo<MapShapes>(() => ({
    lines: path.length > 1
      ? [{ id: "life-path", points: path, className: "ft-map-path", weight: 3, dashArray: "6 6" }]
      : [],
    markers: places.map((place) => ({
      id: place.key,
      lat: place.lat,
      lng: place.lng,
      className: "ft-map-marker",
      html: `<span class="ft-map-pin is-${place.kind}">${place.entries.length > 1 ? place.entries.length : ""}</span>`,
      size: [30, 30] as [number, number],
      // Text, set by the renderer — a place name goes in as written.
      tooltip: place.label,
      selected: place.key === selectedKey
    }))
  }), [places, path, selectedKey]);

  const choosePlace = (place: MapPlace) => {
    setSelectedKey(place.key);
    setView({ kind: "fly", points: [[place.lat, place.lng]], maxZoom: 10, minZoom: 6 });
  };

  const toggleKind = (kind: FamilyMapKind) => {
    setKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const kindCount = (kind: FamilyMapKind) => (entries ?? []).filter((entry) =>
    entry.kind === kind && (!personId || entry.personIds.includes(personId))
  ).length;

  const whatHappened = (entry: FamilyMapEntry): string => {
    if (entry.kind === "event") {
      const type = entry.eventType ? eventTypeLabel(entry.eventType) : "";
      return entry.label && entry.label !== type ? `${type}: ${entry.label}` : type;
    }
    return t(`family:map.kind.${entry.kind}`);
  };

  const whenHappened = (entry: FamilyMapEntry): string =>
    entry.endDate ? formatPartialDateRange(entry.date, entry.endDate) : formatPartialDate(entry.date);

  const peopleIn = shownEntries.reduce((ids, entry) => {
    for (const id of entry.personIds) ids.add(id);
    return ids;
  }, new Set<string>());

  return (
    <DashboardShell active="family" sideNav={<SectionNav {...familyNavProps("map")} />}>
      <section className="audiobook-main-page ft-map-page">
        <LibraryPageHeader
          title={t("family:map.title")}
          subtitle={entries
            ? `${t("family:map.counts.place", { count: places.length })} · ${t("family:common.counts.person", { count: peopleIn.size })}`
            : undefined}
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder={t("family:map.searchPlaceholder")}
        />

        {error && <MessageBox tone="error" title={t("family:map.errors.loadTitle")}>{error}</MessageBox>}

        {entries && entries.length === 0 && (
          <MessageBox tone="info" title={t("family:map.emptyTitle")}>{t("family:map.emptyBody")}</MessageBox>
        )}

        {entries && entries.length > 0 && (
          <>
            <div className="ft-map-filters">
              {focus && (
                <Button
                  variant="chip"
                  className="ft-map-focus"
                  onClick={() => navigate("/family/map")}
                  title={t("family:map.clearFocus")}
                  aria-label={t("family:map.clearFocusAria", { name: focus.name })}
                >
                  <PersonAvatar person={focus} size={20} />
                  <span>{t("family:map.focus", { name: focus.name })}</span>
                  <X size={14} aria-hidden="true" />
                </Button>
              )}
              <div className="ft-map-kinds" role="group" aria-label={t("family:map.kindsAria")}>
                {KINDS.map((kind) => {
                  const Icon = KIND_ICONS[kind];
                  const on = kinds.has(kind);
                  return (
                    <Button
                      key={kind}
                      variant="chip"
                      className={`ft-map-kind is-${kind}${on ? " is-on" : ""}`}
                      aria-pressed={on}
                      onClick={() => toggleKind(kind)}
                    >
                      <Icon size={14} aria-hidden="true" />
                      <span>{t(`family:map.kindPlural.${kind}`)}</span>
                      <span className="ft-map-kind-count">{kindCount(kind)}</span>
                    </Button>
                  );
                })}
              </div>
            </div>

            <div className="ft-map-layout">
              <div className="ft-map-canvas">
                <MapView
                  options={options}
                  shapes={shapes}
                  view={view}
                  onMarkerClick={(key) => setSelectedKey(key)}
                  onMapClick={() => setSelectedKey(null)}
                  className="ft-map"
                  ariaLabel={t("family:map.mapAria")}
                />
              </div>

              <aside className="ft-map-panel" aria-live="polite">
                {selected ? (
                  <>
                    <div className="ft-map-panel-head">
                      <Button
                        variant="icon"
                        onClick={() => setSelectedKey(null)}
                        title={t("family:map.allPlaces")}
                        aria-label={t("family:map.allPlaces")}
                      >
                        <ArrowLeft size={17} />
                      </Button>
                      <div>
                        <h2>{selected.label}</h2>
                        <small>{t("family:map.counts.entry", { count: selected.entries.length })}</small>
                      </div>
                    </div>
                    <ol className="ft-map-entries">
                      {selected.entries.map((entry) => {
                        const Icon = KIND_ICONS[entry.kind];
                        const people = entry.personIds
                          .map((id) => persons.get(id))
                          .filter((person): person is FamilyPerson => person != null);
                        return (
                          <li key={entry.id} className={`ft-map-entry is-${entry.kind}`}>
                            <span className="ft-map-entry-icon" aria-hidden="true"><Icon size={15} /></span>
                            <div className="ft-map-entry-body">
                              <div className="ft-map-entry-what">
                                <strong>{whatHappened(entry)}</strong>
                                {whenHappened(entry) && <span>{whenHappened(entry)}</span>}
                              </div>
                              <div className="ft-map-entry-people">
                                {people.map((person) => (
                                  <a
                                    key={person.id}
                                    href={`/family/people/${person.id}`}
                                    onClick={(event) => followRoute(event, `/family/people/${person.id}`)}
                                  >
                                    <PersonAvatar person={person} size={24} />
                                    <span>{person.name}</span>
                                  </a>
                                ))}
                              </div>
                              {entry.place !== selected.label && <small className="ft-map-entry-place">{entry.place}</small>}
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  </>
                ) : places.length === 0 ? (
                  <p className="ft-map-panel-empty">{t("family:map.noMatches")}</p>
                ) : (
                  <ul className="ft-map-places" aria-label={t("family:map.placesAria")}>
                    {places.map((place) => (
                      <li key={place.key}>
                        <Button variant="bare" className="ft-map-place" onClick={() => choosePlace(place)}>
                          <span className={`ft-map-place-dot is-${place.kind}`} aria-hidden="true"><MapPin size={14} /></span>
                          <span className="ft-map-place-name">{place.label}</span>
                          <span className="ft-map-place-count">{place.entries.length}</span>
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </aside>
            </div>

            {unpinned > 0 && (
              <p className="ft-map-unpinned">{t("family:map.unpinned", { count: unpinned })}</p>
            )}
          </>
        )}
      </section>
    </DashboardShell>
  );
}
