import type { ReactNode } from "react";
import { followReplace } from "../../router";

// One stop on a story's rail: the picture it opens on (or its number), what
// it's called, and when it was.
//
// A link on the signed-in site, so a chapter can be opened in its own tab like
// any other page — and a replacing one, so the whole story stays a single step
// in the trail. A button on a guest page, whose navigation is a query on the
// one share URL rather than an address of its own. One look for both, the same
// bargain the chapter strip already makes.
export function StoryStep({
  href,
  onSelect,
  current,
  label,
  sub,
  mark
}: {
  /** The signed-in site: a real address. */
  href?: string;
  /** A guest page: navigation the page does itself. */
  onSelect?: () => void;
  current: boolean;
  label: string;
  sub?: string;
  mark: ReactNode;
}) {
  const className = `story-step${current ? " is-current" : ""}`;
  const body = (
    <>
      <span className="story-step-mark" aria-hidden="true">{mark}</span>
      <span className="story-step-text">
        <span className="story-step-label">{label}</span>
        {sub && <span className="story-step-sub">{sub}</span>}
      </span>
    </>
  );

  if (href === undefined) {
    return (
      <button
        type="button"
        className={className}
        aria-current={current ? "page" : undefined}
        onClick={onSelect}
      >
        {body}
      </button>
    );
  }

  return (
    <a
      className={className}
      href={href}
      aria-current={current ? "page" : undefined}
      onClick={(event) => followReplace(event, href)}
    >
      {body}
    </a>
  );
}
