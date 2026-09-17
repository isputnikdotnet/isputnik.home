// Guide search runs in the browser over the markdown shipped in the build. These
// pin how a guide becomes sections, that a result lands on the heading GuidePage
// renders, and how the FAQ file is read.
import { describe, expect, it } from "vitest";
import { headingAnchor, plainText, searchGuides, splitSections } from "../src/features/help/search";
import { parseFaq } from "../src/features/help/faq";

const TWO_FACTOR = `# Two-factor authentication

Adds a one-time code to your sign-in.

## Backup codes — save these

When you turn on 2FA you're shown a set of **backup codes**. Each one lets you
sign in **once** when your second factor is out of reach.

![A screenshot](images/1.png)

## Locked out?

Ask an [administrator](control-panel.md#users) to reset two-factor.

\`\`\`
## not a heading inside a fence
\`\`\`

#### A small note

Still part of Locked out.
`;

describe("splitSections", () => {
  const sections = splitSections("two-factor-authentication", TWO_FACTOR);

  it("breaks a guide at its ## and ### headings, keeping the opening", () => {
    expect(sections.map((section) => section.heading)).toEqual([null, "Backup codes — save these", "Locked out?"]);
    expect(sections.every((section) => section.guideTitle === "Two-factor authentication")).toBe(true);
  });

  it("keeps fenced code and deeper headings inside their section", () => {
    const lockedOut = sections[2];
    expect(lockedOut.text).toContain("not a heading inside a fence");
    expect(lockedOut.text).toContain("Still part of Locked out.");
  });

  it("strips markdown the reader never sees", () => {
    expect(sections[1].text).not.toContain("**");
    expect(sections[1].text).not.toContain("images/1.png");
    expect(sections[2].text).toContain("Ask an administrator to reset");
  });

  it("anchors a section the way GitHub (and GuidePage) do", () => {
    expect(sections[1].anchor).toBe("backup-codes-save-these");
    expect(headingAnchor("Locked out?")).toBe("locked-out");
  });
});

describe("searchGuides", () => {
  const sections = [
    ...splitSections("two-factor-authentication", TWO_FACTOR),
    ...splitSections("control-panel", "# The control panel\n\n## Backup\n\nWorth setting up on the day you install.\n\n## Logs\n\nEvery sign-in, and each backup.\n")
  ];

  it("ranks a heading match above a passing mention, and links to the section", () => {
    const hrefs = searchGuides(sections, "backup").map((result) => result.href);
    expect(hrefs.slice(0, 2).sort()).toEqual(["/help/control-panel#backup", "/help/two-factor-authentication#backup-codes-save-these"]);
    expect(hrefs[hrefs.length - 1]).toBe("/help/control-panel#logs");
  });

  it("needs every word, counting the guide's own title", () => {
    expect(searchGuides(sections, "backup banana")).toEqual([]);
    expect(searchGuides(sections, "control logs")[0].href).toBe("/help/control-panel#logs");
  });

  it("marks the hits in the snippet without building HTML", () => {
    const [result] = searchGuides(sections, "install");
    expect(result.snippet.filter((part) => part.hit).map((part) => part.text)).toEqual(["install"]);
  });

  it("treats regex characters in a query as text", () => {
    expect(() => searchGuides(sections, "locked out? (")).not.toThrow();
  });

  it("returns nothing for a blank query", () => {
    expect(searchGuides(sections, "   ")).toEqual([]);
  });
});

describe("plainText", () => {
  it("keeps angle brackets inside code spans while dropping real tags", () => {
    expect(plainText("Named `isputnik-<date>.zip` <br> here")).toBe("Named isputnik-<date>.zip here");
  });

  it("drops comments and table rules", () => {
    expect(plainText("<!-- hidden -->\n| a | b |\n|---|---|\n| 1 | 2 |")).toBe("a b 1 2");
  });
});

describe("parseFaq", () => {
  const markdown = `# Frequently asked questions

<!-- header notes -->

## Can I install it on my phone?

Yes — add it to your home screen.

[Your account › Devices](your-account.md#devices)

## How do I back up my data?
<!-- admin -->

Control panel → Backup.

## A question with no answer yet
`;

  it("reads each ## as a question, its text as the answer, and the admin marker", () => {
    expect(parseFaq(markdown)).toEqual([
      {
        question: "Can I install it on my phone?",
        answer: "Yes — add it to your home screen.\n\n[Your account › Devices](your-account.md#devices)",
        adminOnly: false
      },
      { question: "How do I back up my data?", answer: "Control panel → Backup.", adminOnly: true }
    ]);
  });
});
