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
