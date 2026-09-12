import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: vi.fn() };
});

import { VoiceNotes } from "../src/features/gallery/VoiceNotes";
import type { VoiceNote } from "../src/features/gallery/types";

const notes: VoiceNote[] = [
  { id: "v1", url: "/api/v1", durationSeconds: 42, recordedBy: "Dad", createdAt: "2025-09-09T10:00:00Z" },
  { id: "v2", url: "/api/v2", durationSeconds: 78, recordedBy: "Sergey", createdAt: "2025-09-09T11:00:00Z" }
];

// jsdom has no media pipeline: the element's load/play are stubbed so the
// component's mirror of "what is playing" can be observed without sound.
beforeEach(() => {
  Object.defineProperty(HTMLMediaElement.prototype, "load", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLMediaElement.prototype, "play", { configurable: true, value: vi.fn().mockResolvedValue(undefined) });
  Object.defineProperty(HTMLMediaElement.prototype, "pause", { configurable: true, value: vi.fn() });
  // The player's wave strip draws on a canvas; jsdom has none, and says so loudly without this.
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => null });
});

// Rows are the list; the player is one thing under them. Pressing a row loads
// it into that player, so two recordings never play at once.
describe("VoiceNotes shared player", () => {
  it("shows a row per recording and no player until one is chosen", () => {
    render(<VoiceNotes assetId="p1" notes={notes} canEdit={false} onChanged={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Play the recording by Dad" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play the recording by Sergey" })).toBeInTheDocument();
    expect(document.querySelector("audio")).toBeNull();
  });

  it("loads the chosen recording into the one player, and swaps it for the next", async () => {
    render(<VoiceNotes assetId="p1" notes={notes} canEdit={false} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Play the recording by Dad" }));
    const player = screen.getByLabelText("Now playing: Dad");
    expect(within(player).getByText("Dad")).toBeInTheDocument();
    expect(document.querySelectorAll("audio")).toHaveLength(1);
    expect(document.querySelector("audio")?.getAttribute("src")).toBe("/api/v1");

    await userEvent.click(screen.getByRole("button", { name: "Play the recording by Sergey" }));
    expect(screen.getByLabelText("Now playing: Sergey")).toBeInTheDocument();
    expect(screen.queryByLabelText("Now playing: Dad")).toBeNull();
    expect(document.querySelectorAll("audio")).toHaveLength(1);
    expect(document.querySelector("audio")?.getAttribute("src")).toBe("/api/v2");
  });

  it("offers Remove only to someone who can write on the photo", async () => {
    render(<VoiceNotes assetId="p1" notes={notes} canEdit={false} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "More for the recording by Dad" }));
    expect(screen.getByRole("menuitem", { name: "Download" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Remove this recording" })).toBeNull();
  });
});

// Which recording the player is on is held as an id and looked up in `notes`, so
// the player follows the list: a recording that has gone takes the player with it,
// and a list that is merely re-read leaves it alone. It used to hold the note
// object, with an effect noticing afterwards that it had gone — and until that
// effect ran the player still pointed at a deleted file.
describe("VoiceNotes current recording follows the list", () => {
  it("drops the player when the chosen recording is removed from the list", async () => {
    const { rerender } = render(<VoiceNotes assetId="p1" notes={notes} canEdit onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Play the recording by Dad" }));
    expect(screen.getByLabelText("Now playing: Dad")).toBeInTheDocument();

    rerender(<VoiceNotes assetId="p1" notes={[notes[1]]} canEdit onChanged={vi.fn()} />);
    expect(screen.queryByLabelText("Now playing: Dad")).toBeNull();
    expect(document.querySelector("audio")).toBeNull();
  });

  it("drops the player when the photo changes under it", async () => {
    const { rerender } = render(<VoiceNotes assetId="p1" notes={notes} canEdit onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Play the recording by Dad" }));

    rerender(<VoiceNotes assetId="p2" notes={[]} canEdit onChanged={vi.fn()} />);
    expect(document.querySelector("audio")).toBeNull();
  });

  it("keeps the player when the same list is simply re-read", async () => {
    const { rerender } = render(<VoiceNotes assetId="p1" notes={notes} canEdit onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Play the recording by Dad" }));

    rerender(<VoiceNotes assetId="p1" notes={notes.map((note) => ({ ...note }))} canEdit onChanged={vi.fn()} />);
    expect(screen.getByLabelText("Now playing: Dad")).toBeInTheDocument();
  });
});
