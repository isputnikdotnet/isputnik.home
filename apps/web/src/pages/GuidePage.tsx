import { useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { DashboardShell } from "../app/DashboardShell";
import { useSession } from "../app/SessionContext";
import { followBack, followRoute, navigate } from "../router";
import { Button } from "../shared/Button";
import { MessageBox } from "../shared/MessageBox";
import { cx } from "../shared/cx";
import { repoFileUrl } from "../shared/links";
import { GUIDES, guideBySlug, helpShelves, shelfOf } from "../features/help/catalog";
import { fetchGuideMarkdown } from "../features/help/guideSource";
import { loadDiagrams } from "../features/help/diagrams";
import { ADMIN_MARKER, headingAnchor } from "../features/help/search";

// The guides are the same markdown files as docs/users/, copied into the build
// (see vite.config.ts) and rendered here rather than sent to GitHub. That keeps
// help working on an install with no internet, and keeps what it says matched to
// the version running. "View on GitHub" stays as a way to reach the latest copy.
//
// The page is a handbook: the shelves of guides on the left, the guide in the
// middle, "On this page" on the right. What a guide may carry beyond plain
// markdown is written down in docs/users/README.md ("Writing a guide"):
// diagrams from images/diagrams/ drawn in the page's own colours, a row of
// cards (<div class="guide-cards">), GitHub's "> [!NOTE]" callouts, and
// sections for administrators only (an <!-- admin --> line under a "## ").
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

const CALLOUTS: Record<string, string> = {
  NOTE: "info",
  TIP: "success",
  IMPORTANT: "info",
  WARNING: "warning",
  CAUTION: "error"
};

// Render a guide's markdown to the sanitized HTML that reaches
// dangerouslySetInnerHTML. Exported so the sanitisation can be tested directly.
// The guides ship inside the build today, but this is the one place app markup is
// built from a fetched document, so it must not depend on that staying true:
// interpolated attribute values are escaped here, and DOMPurify then drops any
// script, event handler, or javascript: URL a guide could carry. ADD_ATTR keeps
// target (external links); data-guide is a data-* attr DOMPurify allows by default
// and the in-app link handler reads.
export async function renderGuideHtml(markdown: string): Promise<string> {
  const [{ Marked }, { default: DOMPurify }, diagrams] = await Promise.all([
    import("marked"),
    import("dompurify"),
    loadDiagrams(markdown)
  ]);
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
        // A diagram is drawn inline, so it takes the theme's colours; GitHub shows
        // the same file as a picture in its own fallback colours.
        const diagram = diagrams.get(href ?? "");
        if (diagram) return `<figure class="guide-diagram" role="img" aria-label="${escapeAttr(text)}">${diagram}</figure>`;
        const src = /^https?:\/\//i.test(href ?? "") ? href : `/guides/${(href ?? "").replace(/^\.?\//, "")}`;
        const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
        return `<img src="${escapeAttr(src)}" alt="${escapeAttr(text)}"${titleAttr} loading="lazy" />`;
      },
      // GitHub's alert syntax ("> [!WARNING]") becomes a callout in the tones
      // MessageBox uses; a plain blockquote stays an aside.
      blockquote({ tokens }) {
        const inner = this.parser.parse(tokens);
        const alert = /^\s*<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(inner);
        if (!alert) return `<blockquote>${inner}</blockquote>`;
        const tone = CALLOUTS[alert[1].toUpperCase()];
        return `<div class="guide-callout is-${tone}">${inner.replace(alert[0], "<p>")}</div>`;
      }
    }
  });
  return DOMPurify.sanitize(await marked.parse(markdown), { ADD_ATTR: ["target"] });
}

export interface GuideOutlineEntry {
  id: string;
  text: string;
  adminOnly: boolean;
}

export interface RenderedGuide {
  title: string;
  html: string;
  outline: GuideOutlineEntry[];
  hasAdminSections: boolean;
}

/** The anchor of a guide's opening diagram — "How it works" in the outline. */
export const OVERVIEW_ANCHOR = "how-it-works";

// The whole guide for the reader: the title lifted out (the page draws it with
// its chips), every "## " section wrapped in a <section> that says whether it is
// for administrators, and the outline "On this page" lists.
export async function renderGuide(markdown: string, overviewLabel: string): Promise<RenderedGuide> {
  const adminAnchors = new Set<string>();
  const lines = markdown.split(/\r?\n/);
  lines.forEach((line, index) => {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    const next = lines.slice(index + 1).find((candidate) => candidate.trim());
    if (heading && next && ADMIN_MARKER.test(next)) adminAnchors.add(headingAnchor(heading[1]));
  });

  const template = document.createElement("template");
  template.innerHTML = await renderGuideHtml(markdown);
  const source = template.content;

  const h1 = source.querySelector("h1");
  const title = h1?.textContent?.trim() ?? "";
  h1?.remove();

  const body = document.createElement("div");
  const intro = document.createElement("div");
  intro.className = "guide-intro";
  body.append(intro);
  let target: HTMLElement = intro;
  const outline: GuideOutlineEntry[] = [];

  // The opening diagram: before the first section, on its own or (as marked wraps
  // an image) inside a paragraph.
  const firstSection = [...source.children].findIndex((element) => element.tagName === "H2");
  const diagram = [...source.children]
    .slice(0, firstSection < 0 ? undefined : firstSection)
    .map((element) => (element.matches(".guide-diagram") ? element : element.querySelector(".guide-diagram")))
    .find((element) => element !== null);
  if (diagram) {
    diagram.id = OVERVIEW_ANCHOR;
    outline.push({ id: OVERVIEW_ANCHOR, text: overviewLabel, adminOnly: false });
  }

  for (const node of [...source.childNodes]) {
    if (node instanceof HTMLElement && node.tagName === "H2") {
      const adminOnly = adminAnchors.has(node.id);
      target = document.createElement("section");
      target.className = "guide-section";
      if (adminOnly) target.dataset.admin = "";
      body.append(target);
      outline.push({ id: node.id, text: node.textContent?.trim() ?? "", adminOnly });
    }
    target.append(node);
  }

  return { title, html: body.innerHTML, outline, hasAdminSections: adminAnchors.size > 0 };
}

type Audience = "all" | "using" | "setup";

export function GuidePage({
  slug
}: {
  slug: string;
}) {
  const { t } = useTranslation();
  const { user } = useSession();
  const isAdmin = user.role === "admin";
  const [guide, setGuide] = useState<RenderedGuide | null>(null);
  const [error, setError] = useState("");
  const [audience, setAudience] = useState<Audience>("all");
  const [current, setCurrent] = useState<string | null>(null);
  const githubUrl = repoFileUrl(`docs/users/${slug}.md`);
  const entry = guideBySlug(slug);
  const shelf = shelfOf(slug);
  const overviewLabel = t("guide.howItWorks");

  useEffect(() => {
    let alive = true;
    setGuide(null);
    setError("");
    setAudience("all");

    (async () => {
      const markdown = await fetchGuideMarkdown(slug);
      if (markdown === null) throw new Error(t("guide.notFound"));

      const rendered = await renderGuide(markdown, overviewLabel);
      if (alive) setGuide(rendered);
    })().catch((err) => {
      if (alive) setError(err instanceof Error ? err.message : t("guide.unableToOpen"));
    });

    return () => { alive = false; };
  }, [slug, t, overviewLabel]);

  // Members never see the sections for administrators; an administrator can narrow
  // a guide written for both to either half.
  const shown: Audience = isAdmin ? audience : "using";
  const outline = useMemo(
    () =>
      (guide?.outline ?? []).filter((item) =>
        shown === "all" ? true : shown === "using" ? !item.adminOnly : item.adminOnly || item.id === OVERVIEW_ANCHOR
      ),
    [guide, shown]
  );

  // A link into a section (a search result, an FAQ answer, another guide) names
  // it in the hash. The browser can't jump there on its own — the headings only
  // exist once the markdown has rendered — so do it then, and again whenever the
  // hash changes on a guide that's already open.
  const hash = window.location.hash;
  useEffect(() => {
    if (!guide || !hash) return;
    let id = hash.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      // A malformed escape: look it up as written.
    }
    const target = document.getElementById(id);
    if (!target) return;
    // A link into a part this reader had narrowed away opens the whole guide.
    if (target.closest(".guide-section")?.matches("[data-admin]") ? shown === "using" : shown === "setup") setAudience("all");
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- jump on a new guide or hash, not on every narrowing
  }, [guide, hash]);

  // "On this page" marks the section being read: the last heading above the top
  // third of the window.
  useEffect(() => {
    if (!outline.length) return;
    const onScroll = () => {
      const line = window.innerHeight / 3;
      let at: string | null = outline[0].id;
      for (const item of outline) {
        const element = document.getElementById(item.id);
        if (element && element.getBoundingClientRect().top <= line) at = item.id;
      }
      setCurrent(at);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [outline]);

  const shelves = helpShelves(isAdmin);
  const showAudience = isAdmin && guide?.hasAdminSections;
  const audiences: { value: Audience; label: string }[] = [
    { value: "all", label: t("guide.audienceAll") },
    { value: "using", label: t("guide.audienceUsing") },
    { value: "setup", label: t("guide.audienceSetup") }
  ];

  return (
    <DashboardShell active="help">
      <section className="work-area guide-area">
        <div className="guide-layout">
          <nav className="guide-rail" aria-label={t("guide.allGuides")}>
            <a className="guide-rail-home" href="/help" onClick={(event) => followBack(event, "/help")}>
              <ArrowLeft size={16} aria-hidden="true" />
              {t("help.heading")}
            </a>
            {shelves.map((group) => (
              <div className="guide-rail-group" key={group.id}>
                <p className="guide-rail-title">{group.title}</p>
                {group.guides.map((key) => {
                  const href = `/help/${GUIDES[key].slug}`;
                  return (
                    <a
                      key={key}
                      className={cx("guide-rail-link", GUIDES[key].slug === slug && "is-current")}
                      aria-current={GUIDES[key].slug === slug ? "page" : undefined}
                      href={href}
                      onClick={(event) => followRoute(event, href)}
                    >
                      {GUIDES[key].title}
                    </a>
                  );
                })}
              </div>
            ))}
          </nav>

          <div className="guide-main">
            <a className="audiobook-back-button guide-back" href="/help" onClick={(event) => followBack(event, "/help")}>
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

            {!guide && !error && <p className="management-empty">{t("guide.loading")}</p>}

            {guide && (
              <>
                <header className="guide-head">
                  <p className="eyebrow">{shelf ? t("guide.eyebrow", { shelf: shelf.title }) : t("help.eyebrow")}</p>
                  <h1>{guide.title}</h1>
                  {(entry?.meta?.length || entry?.adminOnly || showAudience) && (
                    <div className="guide-meta">
                      {entry?.adminOnly && <span className="guide-chip is-admin">{t("help.adminBadge")}</span>}
                      {entry?.meta?.map((fact) => (
                        <span className="guide-chip" key={fact}>{fact}</span>
                      ))}
                      {showAudience && (
                        <span className="guide-audience" role="tablist" aria-label={t("guide.audienceLabel")}>
                          {audiences.map((option) => (
                            <Button
                              key={option.value}
                              variant="tab"
                              selected={audience === option.value}
                              onClick={() => setAudience(option.value)}
                            >
                              {option.label}
                            </Button>
                          ))}
                        </span>
                      )}
                    </div>
                  )}
                </header>
                {/* Our own files, shipped inside the image — not user input. */}
                <article
                  className="guide-body"
                  data-audience={shown}
                  onClick={followGuideLink}
                  dangerouslySetInnerHTML={{ __html: guide.html }}
                />
                <p className="guide-source">
                  <a href={githubUrl} target="_blank" rel="noreferrer">
                    {t("guide.viewOnGithub")} <ExternalLink size={14} aria-hidden="true" />
                  </a>
                </p>
              </>
            )}
          </div>

          <nav className="guide-toc" aria-label={t("guide.onThisPage")}>
            {outline.length > 1 && (
              <>
                <p className="guide-rail-title">{t("guide.onThisPage")}</p>
                {outline.map((item) => (
                  <a
                    key={item.id}
                    className={cx("guide-toc-link", current === item.id && "is-current")}
                    href={`#${item.id}`}
                    onClick={(event) => {
                      event.preventDefault();
                      document.getElementById(item.id)?.scrollIntoView({ block: "start", behavior: "smooth" });
                      window.history.replaceState(window.history.state, "", `#${item.id}`);
                      setCurrent(item.id);
                    }}
                  >
                    {item.text}
                    {item.adminOnly && <span className="guide-chip is-admin">{t("help.adminBadge")}</span>}
                  </a>
                ))}
              </>
            )}
          </nav>
        </div>
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
