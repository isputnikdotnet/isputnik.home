import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { DashboardShell } from "../app/DashboardShell";
import { followBack, navigate } from "../router";
import { MessageBox } from "../shared/MessageBox";
import { repoFileUrl } from "../shared/links";
import { fetchGuideMarkdown } from "../features/help/guideSource";
import { headingAnchor } from "../features/help/search";

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
      // marked stopped emitting heading ids in v5, which quietly broke every
      // `(guide.md#some-section)` link the guides already carry — the fragment
      // survived the rewrite above but had nothing to land on. Same slug GitHub
      // makes, so links keep being written the way authors expect.
      heading({ tokens, depth, text }) {
        const inner = this.parser.parseInline(tokens);
        const id = headingAnchor(text);
        return `<h${depth} id="${escapeAttr(id)}">${inner}</h${depth}>`;
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
  slug
}: {
  slug: string;
}) {
  const { t } = useTranslation();
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState("");
  const githubUrl = repoFileUrl(`docs/users/${slug}.md`);

  useEffect(() => {
    let alive = true;
    setHtml(null);
    setError("");

    (async () => {
      const markdown = await fetchGuideMarkdown(slug);
      if (markdown === null) throw new Error(t("guide.notFound"));

      const rendered = await renderGuideHtml(markdown);
      if (alive) setHtml(rendered);
    })().catch((err) => {
      if (alive) setError(err instanceof Error ? err.message : t("guide.unableToOpen"));
    });

    return () => { alive = false; };
  }, [slug, t]);

  // A link into a section (a search result, an FAQ answer, another guide) names
  // it in the hash. The browser can't jump there on its own — the headings only
  // exist once the markdown has rendered — so do it then, and again whenever the
  // hash changes on a guide that's already open.
  const hash = window.location.hash;
  useEffect(() => {
    if (!html || !hash) return;
    let id = hash.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      // A malformed escape: look it up as written.
    }
    const target = document.getElementById(id);
    if (!target) return;
    target.scrollIntoView({ block: "start" });

    // Screenshots above the heading load after the jump and push it down the page
    // (control-panel.md has dozens). Follow the heading as each one arrives — until
    // the reader scrolls for themselves.
    const pending = [...document.querySelectorAll<HTMLImageElement>(".guide-body img")].filter(
      (image) => !image.complete && image.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING
    );
    if (!pending.length) return;
    const follow = () => target.scrollIntoView({ block: "start" });
    const stop = () => {
      pending.forEach((image) => image.removeEventListener("load", follow));
      window.removeEventListener("wheel", stop);
      window.removeEventListener("touchstart", stop);
      window.removeEventListener("keydown", stop);
    };
    pending.forEach((image) => image.addEventListener("load", follow));
    window.addEventListener("wheel", stop, { passive: true });
    window.addEventListener("touchstart", stop, { passive: true });
    window.addEventListener("keydown", stop);
    return stop;
  }, [html, hash]);

  return (
    <DashboardShell active="help">
      <section className="work-area guide-area">
        <a className="audiobook-back-button" href="/help" onClick={(event) => followBack(event, "/help")}>
          <ArrowLeft size={18} aria-hidden="true" />
          <span>{t("help.heading")}</span>
        </a>

        {error && (
          <MessageBox tone="error" title={t("guide.unableTitle")}>
            {error}{" "}
            <Trans
              i18nKey="guide.readOnGithub"
              components={{ link: <a href={githubUrl} target="_blank" rel="noreferrer" /> }}
            />
          </MessageBox>
        )}

        {!html && !error && <p className="management-empty">{t("guide.loading")}</p>}

        {html && (
          <>
            {/* Our own files, shipped inside the image — not user input. */}
            <article className="guide-body" onClick={followGuideLink} dangerouslySetInnerHTML={{ __html: html }} />
            <p className="guide-source">
              <a href={githubUrl} target="_blank" rel="noreferrer">
                {t("guide.viewOnGithub")} <ExternalLink size={14} aria-hidden="true" />
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
export function followGuideLink(event: React.MouseEvent<HTMLElement>) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const href = (event.target as Element).closest?.("a[data-guide]")?.getAttribute("href");
  if (!href) return;
  event.preventDefault();
  navigate(href);
}
