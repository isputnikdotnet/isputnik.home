import type { ReactNode } from "react";
import { followRoute } from "../router";
import { Button } from "./Button";

// A row of small numbers across the top of a page (Device Sync): an icon in the
// tile's colour, what is counted, the number, and a short line beside it — in amber
// when it wants a look. The tiles share the row evenly and go two to a row on phones.
// Colours are the theme's tokens, so a tile wears every theme.

export interface StatTile {
  label: ReactNode;
  value: ReactNode;
  /** A short line beside the number ("620.6 MB", "2 quiet"). */
  sub?: ReactNode;
  tone?: "warn";
  icon?: ReactNode;
  /** The icon's colour; `warn` follows the tile's tone when that is set. */
  iconTone?: "blue" | "gold" | "rose" | "mint" | "ok" | "warn";
  /** Makes the short line a link to where its reason is ("2 need attention" → which). */
  onSubClick?: () => void;
  /** Makes the whole tile a link to the page that lists what it counts (Libraries,
   *  Storage). The label carries the link; it stretches over the tile. */
  href?: string;
}

export function StatTiles({ tiles, label }: { tiles: StatTile[]; /** The row's accessible name. */ label?: string }) {
  return (
    <dl className="stat-tiles" aria-label={label}>
      {tiles.map((tile, index) => (
        <div className={`stat-tile${tile.tone ? ` is-${tile.tone}` : ""}${tile.icon ? " has-icon" : ""}${tile.href ? " is-link" : ""}`} key={index}>
          {tile.icon && (
            <span className={`stat-tile-icon is-${tile.tone === "warn" ? "warn" : tile.iconTone ?? "blue"}`} aria-hidden="true">{tile.icon}</span>
          )}
          <dt>{tile.href ? <a className="stat-tile-cover" href={tile.href} onClick={(event) => followRoute(event, tile.href!)}>{tile.label}</a> : tile.label}</dt>
          <dd>
            <strong>{tile.value}</strong>
            {tile.sub && (tile.onSubClick
              ? <Button variant="text" className="stat-tile-link" onClick={tile.onSubClick}>{tile.sub}</Button>
              : <small>{tile.sub}</small>)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
