// The guide reader builds HTML from a fetched markdown document and hands it to
// dangerouslySetInnerHTML. The guides ship inside the build today, but the render
// path must be safe regardless: renderGuideHtml sanitizes with DOMPurify and
// escapes the attributes its custom renderer interpolates. These pin that a
// hostile guide can't smuggle script, event handlers, or javascript: URLs through.
import { describe, expect, it } from "vitest";
import { renderGuideHtml } from "../src/pages/GuidePage";

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
