// The house email template. Two things here are load-bearing rather than
// cosmetic: every interpolated value is escaped (names, titles and email
// addresses all reach this from user input), and the two renditions are built
// from one description so they cannot say different things.
import { describe, expect, it } from "vitest";
import { renderEmail, type EmailBlock } from "../src/core/email-template.js";

const render = (blocks: EmailBlock[], over: Record<string, unknown> = {}) =>
  renderEmail({ title: "A title", blocks, ...over });

describe("email template", () => {
  it("sends both renditions, and the HTML is a whole document", () => {
    const { html, text } = render([{ kind: "text", text: "Hello there." }]);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("</html>");
    expect(text).toContain("A title");
    expect(text).toContain("Hello there.");
    // No markup leaks into the text part.
    expect(text).not.toMatch(/<[a-z]/i);
  });

  it("escapes everything that came from a person", () => {
    const nasty = 'Bobby <img src=x onerror="alert(1)"> & "friends"';
    const { html, text } = render([
      { kind: "text", text: nasty },
      { kind: "subject", text: nasty },
      { kind: "facts", rows: [{ label: nasty, value: nasty }] }
    ], { title: nasty });

    // The words survive as text — that is what escaping IS. What must not survive
    // is a tag: no unescaped "<" ever reaches the output around them.
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;friends&quot;");
    // The text part is not markup, so it keeps the characters as typed.
    expect(text).toContain(nasty);
  });

  it("drops a link that isn't http, rather than linking or echoing it", () => {
    const { html, text } = render([{ kind: "button", label: "Click", url: "javascript:alert(1)" }]);
    expect(html).not.toContain("javascript:");
    expect(text).not.toContain("javascript:");
    // The label survives, so the message still reads.
    expect(html).toContain("Click");
    expect(text).toContain("Click");
  });

  it("keeps an https link, in the button and spelled out beneath it", () => {
    const { html, text } = render([
      { kind: "button", label: "Open Shared with me", url: "https://home.example/shared" }
    ]);
    expect(html).toContain('href="https://home.example/shared"');
    // Spelled out too: a button whose href is stripped still has to be usable.
    expect(html.split("https://home.example/shared").length - 1).toBeGreaterThanOrEqual(2);
    expect(text).toContain("Open Shared with me: https://home.example/shared");
  });

  describe("the code block", () => {
    it("keeps the code as one unbroken run of characters", () => {
      const { html } = render([{ kind: "code", code: "123456" }]);
      // Split into per-character cells it would copy back with separators in it.
      expect(html).toContain(">123456<");
    });

    it("makes it big and bold, and spaces it without splitting it", () => {
      const { html } = render([{ kind: "code", code: "123456" }]);
      const span = html.slice(html.indexOf("<span class=\"code"), html.indexOf(">123456<"));
      expect(span).toMatch(/font-size:38px/);
      expect(span).toMatch(/font-weight:700/);
      expect(span).toMatch(/letter-spacing:8px/);
      // The trailing gap letter-spacing adds is balanced back, so it looks centred.
      expect(span).toMatch(/text-indent:8px/);
      expect(span).toMatch(/monospace/);
    });

    it("puts the code in the text rendition too, and its caption", () => {
      const { text } = render([{ kind: "code", code: "123456", caption: "Expires in 10 minutes." }]);
      expect(text).toContain("123456");
      expect(text).toContain("Expires in 10 minutes.");
    });
  });

  it("uses the first paragraph as the preview line unless given one", () => {
    const { html } = render([{ kind: "text", text: "The first thing said." }]);
    expect(html).toContain("The first thing said.");

    const withPreheader = render([{ kind: "text", text: "Body copy." }], { preheader: "Peek at this" });
    expect(withPreheader.html).toContain("Peek at this");
  });

  it("signs off with the default unless a footnote is given", () => {
    expect(render([{ kind: "text", text: "x" }]).text).toContain("Sent by your isputnik.home server.");
    expect(render([{ kind: "text", text: "x" }], { footnote: "Custom sign-off." }).text)
      .toContain("Custom sign-off.");
  });

  it("renders facts as label and value in both", () => {
    const rows = [{ label: "Source IP", value: "203.0.113.5" }, { label: "When", value: "2026-08-10 12:00 UTC" }];
    const { html, text } = render([{ kind: "facts", rows }]);
    expect(text).toContain("Source IP: 203.0.113.5");
    expect(text).toContain("When: 2026-08-10 12:00 UTC");
    expect(html).toContain("203.0.113.5");
    expect(html).toContain("Source IP");
  });

  it("leaves no run of blank lines in the text part", () => {
    const { text } = render([
      { kind: "text", text: "One." },
      { kind: "facts", rows: [{ label: "A", value: "b" }] },
      { kind: "note", text: "Two." }
    ]);
    expect(text).not.toMatch(/\n{3,}/);
  });
});
