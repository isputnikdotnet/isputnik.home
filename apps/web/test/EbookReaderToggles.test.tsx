import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The reader's engine (vendored foliate-js) needs a real browser; these tests are
// about the chrome around it, so the engine module is replaced with the few pure
// helpers the chrome reads, and the book's fetch never settles — the reader sits
// in its loading state with every toolbar drawn.
vi.mock("../src/features/audiobooks/reader/foliate", () => ({
  applyLayout: vi.fn(),
  countToc: () => 0,
  createFoliateView: vi.fn(),
  drawHighlight: vi.fn(),
  highlightFill: () => "",
  themeColors: () => ({ bg: "#fff", fg: "#000", link: "#00f" }),
  themeCSS: () => "",
  HIGHLIGHT_COLORS: { yellow: "#ff0" }
}));

const { EbookReader } = await import("../src/features/audiobooks/reader/EbookReader");

// A toggle's state has to reach a screen reader, not only the CSS class that
// tints it: each panel button is a disclosure (aria-expanded, and aria-controls
// naming the drawer while it is open), and each segmented choice in the text and
// settings panels says whether it is the one in force (aria-pressed).

beforeEach(() => {
  localStorage.clear();
  vi.mocked(globalThis.fetch).mockImplementation(() => new Promise<Response>(() => {}));
});

function reader() {
  render(
    <EbookReader
      bookId="b1"
      documentId="d1"
      format="epub"
      url="/api/book.epub"
      storageKey="ebk-test"
      initialProgress={null}
      title="Treasure Island"
      guest
    />
  );
}

describe("EbookReader toggles", () => {
  it("marks a panel button expanded while its panel is open, pointing at the drawer", async () => {
    const user = userEvent.setup();
    reader();
    const settings = screen.getByRole("button", { name: "Settings" });
    const search = screen.getByRole("button", { name: "Search" });
    const chapters = screen.getByRole("button", { name: "Chapters" });
    for (const button of [settings, search, chapters, screen.getByRole("button", { name: "Text options" })]) {
      expect(button).toHaveAttribute("aria-expanded", "false");
      expect(button).not.toHaveAttribute("aria-controls");
    }

    await user.click(settings);
    expect(settings).toHaveAttribute("aria-expanded", "true");
    const drawer = document.getElementById(settings.getAttribute("aria-controls")!);
    expect(drawer).toHaveClass("ebk-drawer");
    // Only the open panel's button claims the drawer.
    expect(search).toHaveAttribute("aria-expanded", "false");
    expect(search).not.toHaveAttribute("aria-controls");

    // Another panel takes the drawer over.
    await user.click(chapters);
    expect(chapters).toHaveAttribute("aria-expanded", "true");
    expect(chapters).toHaveAttribute("aria-controls", drawer!.id);
    expect(settings).toHaveAttribute("aria-expanded", "false");

    // And pressing it again closes it.
    await user.click(chapters);
    expect(chapters).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector(".ebk-drawer")).toBeNull();
  });

  it("says which theme, font and layout are in force with aria-pressed", async () => {
    const user = userEvent.setup();
    reader();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const drawer = document.querySelector<HTMLElement>(".ebk-drawer")!;
    const pressed = (name: string | RegExp) => within(drawer).getByRole("button", { name });

    expect(pressed("Light")).toHaveAttribute("aria-pressed", "true");
    expect(pressed("Dark")).toHaveAttribute("aria-pressed", "false");
    await user.click(pressed("Dark"));
    expect(pressed("Dark")).toHaveAttribute("aria-pressed", "true");
    expect(pressed("Light")).toHaveAttribute("aria-pressed", "false");

    expect(pressed("Serif")).toHaveAttribute("aria-pressed", "true");
    await user.click(pressed("Sans"));
    expect(pressed("Sans")).toHaveAttribute("aria-pressed", "true");
    expect(pressed("Serif")).toHaveAttribute("aria-pressed", "false");

    expect(pressed(/1$/)).toHaveAttribute("aria-pressed", "true");
    await user.click(pressed(/2$/));
    expect(pressed(/2$/)).toHaveAttribute("aria-pressed", "true");
    expect(pressed(/1$/)).toHaveAttribute("aria-pressed", "false");
  });
});
