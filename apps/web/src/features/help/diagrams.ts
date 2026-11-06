import { useEffect, useState } from "react";

// Diagrams in the guides are SVG files under docs/users/images/diagrams/. GitHub
// shows them as pictures, in the colours their own <style> block falls back to;
// the app draws them inline instead, so their classes (d-box, d-flow, …, styled in
// styles/about.css) take whichever theme the reader wears. The file's <style> is
// dropped on the way in — it would otherwise paint over the theme, and leak.
//
// Only that folder is inlined: any other SVG a guide shows stays an <img>.

const DIAGRAM = /!\[[^\]]*\]\((images\/diagrams\/[a-z0-9-]+\.svg)\)/gi;

const cache = new Map<string, Promise<string | null>>();

export function loadDiagram(path: string): Promise<string | null> {
  let pending = cache.get(path);
  if (!pending) {
    pending = (async () => {
      try {
        const response = await fetch(`/guides/${path}`);
        const text = response.ok ? await response.text() : "";
        // An unknown path is answered with the app's index.html at status 200.
        if (!text.trimStart().startsWith("<svg") && !text.trimStart().startsWith("<?xml")) return null;
        const { default: DOMPurify } = await import("dompurify");
        const svg = DOMPurify.sanitize(text, { USE_PROFILES: { svg: true }, FORBID_TAGS: ["style"] });
        return svg.includes("<svg") ? svg : null;
      } catch {
        return null;
      }
    })();
    pending.then((svg) => {
      if (svg === null) cache.delete(path);
    });
    cache.set(path, pending);
  }
  return pending;
}

/** Every diagram a guide shows, by the path the markdown names it with. */
export async function loadDiagrams(markdown: string): Promise<Map<string, string>> {
  const paths = [...new Set([...markdown.matchAll(DIAGRAM)].map((match) => match[1]))];
  const loaded = await Promise.all(paths.map(async (path) => [path, await loadDiagram(path)] as const));
  return new Map(loaded.filter((entry): entry is readonly [string, string] => entry[1] !== null));
}

export function useDiagram(path: string | undefined): string | null {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    loadDiagram(path).then((loaded) => {
      if (alive) setSvg(loaded);
    });
    return () => {
      alive = false;
    };
  }, [path]);
  return svg;
}
