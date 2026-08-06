// The small pieces the Duplicate cleanup page's parts share.
//
// This file was 1,000 lines: the payload the Duplicate photos and Duplicate folders
// pages both loaded, the folder vocabulary they worked in, and the two pickers that
// drove — "which folders to work on" and "where to keep photos". Those pages are gone,
// and a cleanup carries its own snapshot rather than a shared view of one install-wide
// scan, so all of that went with them. What is left is what the cleanup's own cards,
// job card and viewer actually use.
import { ImageOff } from "lucide-react";

/** Where a copy sits when it sits in no folder at all. Deliberately not "Library root":
 *  the subject here is a PHOTO, and "root" reads as a folder you could go and open. */
export const TOP_LEVEL = "Top level";
export const TOP_LEVEL_HINT = "Top level — directly in the library's own folder, not in any subfolder";

export function formatWhen(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

const FOLDER_PREVIEW_LIMIT = 4;

/** The pictures themselves — the fastest way to recognise which holiday this is. */
export function FolderStrip({ urls, total }: { urls: string[]; total?: number }) {
  const strip = urls.slice(0, FOLDER_PREVIEW_LIMIT);
  const hidden = Math.max((total ?? urls.length) - strip.length, 0);
  return (
    <div className="dup-set-strip" aria-hidden="true">
      {strip.length > 0
        ? strip.map((url) => <img key={url} src={url} alt="" loading="lazy" />)
        : <span className="dup-set-strip-empty"><ImageOff size={18} /></span>}
      {hidden > 0 && (
        <span className="dup-set-strip-more">
          +{hidden}
          <small>more</small>
        </span>
      )}
    </div>
  );
}
