import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { MODE_ICONS, routeNames } from "./story-route";
import type { StoryMapPoint } from "./types";

// "Bolzano 🚗 Ortisei 🥾 Cortina d'Ampezzo" — the route in words, with the way
// you travelled drawn between the names rather than described in them. An
// author's own caption always wins; a route with an unnamed stop falls back to
// a count, because a caption with a hole in it reads worse.
export function RouteCaption({ stops, caption }: { stops: StoryMapPoint[]; caption: string | null }) {
  const { t } = useTranslation(["stories"]);
  if (caption) return <span>{caption}</span>;
  if (!routeNames(stops)) return <span>{t("stories:block.routeStops", { count: stops.length })}</span>;

  return (
    <span className="story-route-caption">
      {stops.map((stop, index) => {
        const Icon = stop.mode ? MODE_ICONS[stop.mode] : null;
        return (
          <Fragment key={index}>
            {index > 0 && (
              Icon
                ? <Icon size={13} aria-label={t(`stories:map.modes.${stop.mode}` as "stories:map.modes.walk")} />
                : <span aria-hidden="true">→</span>
            )}
            <span>{stop.label}</span>
          </Fragment>
        );
      })}
    </span>
  );
}
