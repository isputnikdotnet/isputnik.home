import { useEffect, useState } from "react";
import { splitSections, type GuideSection } from "./search";

// One guide's markdown, as shipped in the build under /guides/.
//
// An unknown guide doesn't 404: both Vite and the server answer any unmatched path
// with index.html at status 200, so the status alone can't be trusted. The
// give-away is the body — a guide always starts with its "# Title", never with a
// tag. Without this check a bad slug would read the app's own HTML as prose.
export async function fetchGuideMarkdown(slug: string): Promise<string | null> {
  const response = await fetch(`/guides/${slug}.md`, { headers: { Accept: "text/markdown" } });
  const markdown = response.ok ? await response.text() : "";
  return !markdown || markdown.trimStart().startsWith("<") ? null : markdown;
}

// Search reads every guide the person can open. Fetched once per page load and
// only when someone starts searching — twenty small files, served from the
// service worker's guide cache after the first time.
const sectionCache = new Map<string, Promise<GuideSection[]>>();

function guideSections(slug: string): Promise<GuideSection[]> {
  let pending = sectionCache.get(slug);
  if (!pending) {
    pending = fetchGuideMarkdown(slug).then((markdown) => {
      if (markdown === null) throw new Error(`Guide ${slug} is missing`);
      return splitSections(slug, markdown);
    });
    // A failed fetch (offline before the guides were ever cached) mustn't stick.
    pending.catch(() => sectionCache.delete(slug));
    sectionCache.set(slug, pending);
  }
  return pending;
}

export type GuideIndexState =
  | { status: "idle" | "loading" | "error"; sections: null }
  | { status: "ready"; sections: GuideSection[] };

export function useGuideIndex(slugs: string[], enabled: boolean): GuideIndexState {
  const [state, setState] = useState<GuideIndexState>({ status: "idle", sections: null });
  const key = slugs.join(",");

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setState((current) => (current.status === "ready" ? current : { status: "loading", sections: null }));
    Promise.all(key.split(",").map(guideSections))
      .then((perGuide) => {
        if (alive) setState({ status: "ready", sections: perGuide.flat() });
      })
      .catch(() => {
        if (alive) setState({ status: "error", sections: null });
      });
    return () => {
      alive = false;
    };
  }, [key, enabled]);

  return state;
}
