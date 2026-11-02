import type { CSSProperties } from "react";

// The picture a `cover-backdrop` box blurs into the space its cover leaves: the
// same image, so a cover of another shape than its box fills it without cropping
// and without black bars (components/primitives.css). Nothing when there is none.
export function coverBackdrop(url: string | null | undefined): CSSProperties | undefined {
  if (!url) return undefined;
  return { "--cover": `url("${url.replace(/["\\]/g, "\\$&")}")` } as CSSProperties;
}
