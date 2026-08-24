import { useEffect, useState } from "react";
import { ArrowLeft, ExternalLink } from "lucide-react";
import type { PublicUser } from "../api";
import { DashboardShell } from "../app/DashboardShell";
import { followBack, followRoute, navigate } from "../router";
import { MessageBox } from "../shared/MessageBox";
import { repoFileUrl } from "../shared/links";

// The guides are the same markdown files as docs/users/, copied into the build
// (see vite.config.ts) and rendered here rather than sent to GitHub. That keeps
// help working on an install with no internet, and keeps what it says matched to
// the version running. "View on GitHub" stays as a way to reach the latest copy.
//
// marked is loaded on demand: it's ~35 KB that only a reader of the guides needs.

// Attribute-safe interpolation for the custom renderer: a title or href carrying
// a quote or angle bracket must not break out of the attribute it's placed in.
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Render a guide's markdown to the sanitized HTML that reaches
// dangerouslySetInnerHTML. Exported so the sanitisation can be tested directly.
// The guides ship inside the build today, but this is the one place app markup is
// built from a fetched document, so it must not depend on that staying true:
// interpolated attribute values are escaped here, and DOMPurify then drops any
// script, event handler, or javascript: URL a guide could carry. ADD_ATTR keeps
// target (external links); data-guide is a data-* attr DOMPurify allows by default
// and the in-app link handler reads.
export async function renderGuideHtml(markdown: string): Promise<string> {
  const [{ Marked }, { default: DOMPurify }] = await Promise.all([import("marked"), import("dompurify")]);
  const marked = new Marked({ gfm: true });
  // Rewrite the two link kinds the guides use so they work from /help/:slug:
  // sibling guides become in-app routes, and image paths resolve against the
  // copied folder rather than the current URL.
  marked.use({
    renderer: {
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens);
        const guide = /^([a-z0-9-]+)\.md(#.*)?$/i.exec(href ?? "");
        if (guide) {
          // Escape the fragment too — `.*` admits a quote, which would otherwise
          // break out of the href attribute (guide[1] is [a-z0-9-] so it's safe).
          return `<a href="/help/${guide[1]}${escapeAttr(guide[2] ?? "")}" data-guide="${guide[1]}">${inner}</a>`;
        }
        const external = /^https?:\/\//i.test(href ?? "");
        const attrs = external ? ' target="_blank" rel="noreferrer"' : "";
        const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
        return `<a href="${escapeAttr(href ?? "")}"${titleAttr}${attrs}>${inner}</a>`;
      },
      image({ href, title, text }) {
        const src = /^https?:\/\//i.test(href ?? "") ? href : `/guides/${(href ?? "").replace(/^\.?\//, "")}`;
        const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
        return `<img src="${escapeAttr(src)}" alt="${escapeAttr(text)}"${titleAttr} loading="lazy" />`;
      }
    }
  });
  return DOMPurify.sanitize(await marked.parse(markdown), { ADD_ATTR: ["target"] });
}

export function GuidePage({
  slug,
  user,
  logout
}: {
  slug: string;
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState("");
  const githubUrl = repoFileUrl(`docs/users/${slug}.md`);

  useEffect(() => {
    let alive = true;
    setHtml(null);
    setError("");

    (async () => {
      // An unknown guide doesn't 404: both Vite and the server answer any unmatched
      // path with index.html at status 200, so the status alone can't be trusted.
      // The give-away is the body — a guide always starts with its "# Title", never
      // with a tag. Without this check a bad slug renders the app's own HTML as if
      // it were prose.
      const response = await fetch(`/guides/${slug}.md`, { headers: { Accept: "text/markdown" } });
      const markdown = response.ok ? await response.text() : "";
      if (!markdown || markdown.trimStart().startsWith("<")) throw new Error("That guide doesn't exist.");

      const rendered = await renderGuideHtml(markdown);
      if (alive) setHtml(rendered);
    })().catch((err) => {
      if (alive) setError(err instanceof Error ? err.message : "Unable to open this guide.");
    });

    return () => { alive = false; };
  }, [slug]);

  return (
    <DashboardShell active="help" user={user} logout={logout}>
      <section className="work-area guide-area">
        <a className="audiobook-back-button" href="/help" onClick={(event) => followBack(event, "/help")}>
          <ArrowLeft size={18} aria-hidden="true" />
          <span>Help &amp; guides</span>
        </a>

        {error && (
          <MessageBox tone="error" title="Unable to open this guide">
            {error} <a href={githubUrl} target="_blank" rel="noreferrer">Read it on GitHub</a> instead.
          </MessageBox>
        )}

        {!html && !error && <p className="management-empty">Loading…</p>}

        {html && (
          <>
            {/* Our own files, shipped inside the image — not user input. */}
            <article className="guide-body" onClick={followGuideLink} dangerouslySetInnerHTML={{ __html: html }} />
            <p className="guide-source">
              <a href={githubUrl} target="_blank" rel="noreferrer">
                View this guide on GitHub <ExternalLink size={14} aria-hidden="true" />
              </a>
            </p>
          </>
        )}
      </section>
    </DashboardShell>
  );
}

// Links between guides are plain <a> elements inside rendered HTML, so they'd
// reload the whole app. Catch them on the way up and route instead — while still
// letting a modified click (new tab, new window) behave normally.
function followGuideLink(event: React.MouseEvent<HTMLElement>) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const href = (event.target as Element).closest?.("a[data-guide]")?.getAttribute("href");
  if (!href) return;
  event.preventDefault();
  navigate(href);
}
