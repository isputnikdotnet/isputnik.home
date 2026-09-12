import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudiobookBookDetail } from "../src/features/audiobooks/types";

vi.mock("../src/api", () => ({
  api: vi.fn(async (path: string) => (path.endsWith("/bookmarks") ? { bookmarks: [] } : { progress: null }))
}));
vi.mock("../src/offline/downloads", () => ({ getDownloadedFileUrl: vi.fn(async () => null) }));
vi.mock("../src/offline/progress", () => ({
  getLocalProgress: vi.fn(async () => null),
  persistProgress: vi.fn(async () => undefined)
}));

const { AudioPlayer } = await import("../src/features/audiobooks/AudioPlayer");

// The book player's toggles have to tell a screen reader what their class tells
// the eye: the menu and list buttons are disclosures (aria-expanded, with
// aria-controls naming what they opened), the current chapter is marked
// aria-current, and an armed sleep timer describes itself with the countdown its
// fixed "Sleep timer" name would otherwise hide. jsdom has no media pipeline, so
// the element's methods are stubbed.

const file = (id: string, title: string) => ({
  id, relativePath: `${id}.mp3`, mimeType: "audio/mpeg", trackNumber: null, chapterTitle: title,
  durationSeconds: 600, size: 1, modifiedAt: null, status: "available" as const
});

const book = {
  id: "b1", title: "Treasure Island", files: [file("f1", "The Old Sea-dog"), file("f2", "Black Dog")]
} as unknown as AudiobookBookDetail;

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
});
afterEach(() => { vi.restoreAllMocks(); });

describe("AudioPlayer toggles", () => {
  it("expands the chapter list, points at it, and marks the chapter playing now", async () => {
    const user = userEvent.setup();
    render(<AudioPlayer book={book} />);
    const toggle = screen.getByRole("button", { name: "Chapter list" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).not.toHaveAttribute("aria-controls");

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const list = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(list).toHaveClass("player-chapter-list");
    expect(within(list).getByRole("button", { name: /The Old Sea-dog/ })).toHaveAttribute("aria-current", "true");
    expect(within(list).getByRole("button", { name: /Black Dog/ })).not.toHaveAttribute("aria-current");

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).not.toHaveAttribute("aria-controls");
  });

  it("opens the speed menu as a disclosure and marks the speed in force", async () => {
    const user = userEvent.setup();
    render(<AudioPlayer book={book} />);
    const speed = screen.getByRole("button", { name: "Playback speed" });
    await user.click(speed);
    expect(speed).toHaveAttribute("aria-expanded", "true");
    const menu = () => document.getElementById(speed.getAttribute("aria-controls")!)!;
    expect(menu()).toHaveClass("player-speed-menu");
    expect(within(menu()).getByRole("button", { name: "1×" })).toHaveAttribute("aria-pressed", "true");
    // Choosing closes the menu.
    await user.click(within(menu()).getByRole("button", { name: "1.5×" }));
    expect(speed).toHaveAttribute("aria-expanded", "false");
    expect(speed).not.toHaveAttribute("aria-controls");

    await user.click(speed);
    expect(within(menu()).getByRole("button", { name: "1.5×" })).toHaveAttribute("aria-pressed", "true");
    expect(within(menu()).getByRole("button", { name: "1×" })).toHaveAttribute("aria-pressed", "false");
  });

  it("describes an armed sleep timer by its countdown, and drops the description when it is off", async () => {
    const user = userEvent.setup();
    render(<AudioPlayer book={book} />);
    const sleep = screen.getByRole("button", { name: "Sleep timer" });
    expect(sleep).not.toHaveAttribute("aria-describedby");
    expect(sleep).toHaveAttribute("aria-expanded", "false");

    await user.click(sleep);
    expect(sleep).toHaveAttribute("aria-expanded", "true");
    const menu = document.getElementById(sleep.getAttribute("aria-controls")!)!;
    expect(menu).toHaveClass("player-sleep-menu");
    await user.click(within(menu).getByRole("button", { name: "15 min" }));

    await waitFor(() => expect(sleep).toHaveAttribute("aria-expanded", "false"));
    expect(sleep).toHaveAccessibleDescription("15:00");

    await user.click(sleep);
    expect(screen.getByRole("button", { name: "15 min" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "End of chapter" }));
    expect(sleep).toHaveAccessibleDescription("Chapter");

    await user.click(sleep);
    await user.click(screen.getByRole("button", { name: "Off" }));
    expect(sleep).not.toHaveAttribute("aria-describedby");
  });

  it("expands the bookmark list the same way", async () => {
    const user = userEvent.setup();
    render(<AudioPlayer book={book} showBookmark />);
    const toggle = screen.getByRole("button", { name: "Bookmarks" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toHaveClass("player-bookmark-list");
  });
});
