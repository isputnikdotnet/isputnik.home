// The guide reader builds HTML from a fetched markdown document and hands it to
// dangerouslySetInnerHTML. The guides ship inside the build today, but the render
// path must be safe regardless: renderGuideHtml sanitizes with DOMPurify and
// escapes the attributes its custom renderer interpolates. These pin that a
// hostile guide can't smuggle script, event handlers, or javascript: URLs through.
import { describe, expect, it } from "vitest";
import { renderGuide, renderGuideHtml } from "../src/pages/GuidePage";

describe("renderGuideHtml sanitisation", () => {
  it("strips a raw <script> tag", async () => {
    const html = await renderGuideHtml("# Title\n\n<script>window.stolen=1</script>\n\nBody.");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("window.stolen");
  });

  it("drops an inline event handler", async () => {
    const html = await renderGuideHtml('# T\n\n<img src="x" onerror="alert(1)">');
    expect(html).not.toMatch(/onerror/i);
  });

  it("neutralises a javascript: link", async () => {
    const html = await renderGuideHtml("[click](javascript:alert(1))");
    expect(html.toLowerCase()).not.toContain("javascript:alert");
  });

  it("does not let a crafted title break out of its attribute", async () => {
    // A title carrying a quote + handler would, unescaped, become a real attribute.
    // The quote is escaped, so it stays inert text inside title — assert via the DOM
    // that no onmouseover attribute actually landed on the anchor.
    const html = await renderGuideHtml('[x](https://example.com "a\\" onmouseover=alert(1) x=\\"")');
    const div = document.createElement("div");
    div.innerHTML = html;
    const anchor = div.querySelector("a");
    expect(anchor?.hasAttribute("onmouseover")).toBe(false);
  });

  it("escapes a quote in an in-app guide link's fragment", async () => {
    // The `.md#...` fragment is `.*`, which admits a quote that could break out of
    // the href attribute if not escaped.
    const html = await renderGuideHtml('[x](passkeys.md#"style=color:red)');
    const div = document.createElement("div");
    div.innerHTML = html;
    const anchor = div.querySelector("a");
    expect(anchor?.getAttribute("style")).toBeNull();
  });

  it("keeps ordinary guide content: a heading, an external link, an in-app link", async () => {
    const html = await renderGuideHtml(
      "# Welcome\n\nSee [the site](https://example.com) and [passkeys](passkeys.md)."
    );
    expect(html).toContain("Welcome");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    // In-app guide links keep the data-guide hook the click handler reads.
    expect(html).toContain('data-guide="passkeys"');
  });
});

describe("renderGuide: the handbook's shapes", () => {
  const GUIDE = [
    "# Phones",
    "",
    "What it is.",
    "",
    "> [!WARNING]",
    "> **One copy.** Keep another.",
    "",
    "## Using it",
    "",
    "1. Open it.",
    "",
    "## Setting it up",
    "<!-- admin -->",
    "",
    "Admins only.",
    "",
    "### A detail",
    "",
    "Still admin."
  ].join("\n");

  it("turns a GitHub alert into a callout in a MessageBox tone", async () => {
    const html = await renderGuideHtml(GUIDE);
    expect(html).toContain('class="guide-callout is-warning"');
    expect(html).not.toContain("[!WARNING]");
  });

  it("lifts the title out and wraps each section, marking the administrators' part", async () => {
    const guide = await renderGuide(GUIDE, "How it works");
    expect(guide.title).toBe("Phones");
    expect(guide.html).not.toContain("<h1");
    expect(guide.hasAdminSections).toBe(true);
    expect(guide.outline).toEqual([
      { id: "using-it", text: "Using it", adminOnly: false },
      { id: "setting-it-up", text: "Setting it up", adminOnly: true }
    ]);
    const div = document.createElement("div");
    div.innerHTML = guide.html;
    const admin = div.querySelector(".guide-section[data-admin]");
    expect(admin?.querySelector("h2")?.id).toBe("setting-it-up");
    expect(admin?.querySelector("h3")?.id).toBe("a-detail");
    expect(div.querySelector(".guide-intro p")?.textContent).toBe("What it is.");
  });
});
