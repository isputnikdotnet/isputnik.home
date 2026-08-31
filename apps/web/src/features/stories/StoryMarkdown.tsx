import { useEffect, useState } from "react";

// Story text blocks are markdown. Unlike the shipped guides (GuidePage), this is
// content a member typed, so the allowlist is tight rather than default:
//
// - no raw HTML survives — ALLOWED_TAGS is an explicit prose set
// - no images: a photo belongs in a media block, where access control applies;
//   an `![](…)` would otherwise hotlink anything the *viewer's* browser can fetch
// - links keep href only, and open in a new tab with rel="noopener noreferrer"
//
// marked + DOMPurify are dynamically imported (~35 KB) so a reader who never
// opens a story doesn't pay for them, exactly as the guides do it.

const ALLOWED_TAGS = [
  "p", "br", "hr",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "em", "del", "blockquote",
  "ul", "ol", "li",
  "code", "pre",
  "a"
];

export async function renderStoryMarkdown(markdown: string): Promise<string> {
  const [{ Marked }, { default: DOMPurify }] = await Promise.all([import("marked"), import("dompurify")]);
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      // Drop images entirely — keep the alt text so nothing silently vanishes.
      image({ text }) {
        return text ? escapeHtml(text) : "";
      },
      link({ href, tokens }) {
        const inner = this.parser.parseInline(tokens);
        // Only http(s) and in-app paths; a javascript:/data: URL renders as plain
        // text. DOMPurify would strip it anyway — this keeps the words visible.
        const safe = /^(https?:\/\/|\/)[^\s]*$/i.test(href ?? "");
        if (!safe) return inner;
        const external = /^https?:\/\//i.test(href ?? "");
        const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : "";
        return `<a href="${escapeHtml(href ?? "")}"${attrs}>${inner}</a>`;
      }
    }
  });
  return DOMPurify.sanitize(await marked.parse(markdown), {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ["href", "target", "rel"]
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Rendered markdown. Shows the raw source until the renderer loads, so a slow
 *  chunk shows the words rather than an empty gap. */
export function StoryMarkdown({ source, className }: { source: string; className?: string }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    renderStoryMarkdown(source)
      .then((rendered) => { if (alive) setHtml(rendered); })
      .catch(() => { if (alive) setHtml(null); });
    return () => { alive = false; };
  }, [source]);

  const classes = ["story-prose", className].filter(Boolean).join(" ");
  if (html === null) {
    return <div className={classes}>{source}</div>;
  }
  // Sanitized above with an explicit tag/attribute allowlist.
  return <div className={classes} dangerouslySetInnerHTML={{ __html: html }} />;
}
