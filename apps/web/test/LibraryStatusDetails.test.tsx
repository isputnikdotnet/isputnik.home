import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LibraryStatus } from "../src/features/control/libraries/LibraryStatus";
import type { ManagedLibrary } from "../src/features/control/libraries/managed-library";

// A video library's metadata pass (posters, plots, cast) on the Libraries page:
// it used to read "Up to date" all the while one ran.
const library = (metadata: NonNullable<NonNullable<ManagedLibrary["engine"]>["metadata"]> | null): ManagedLibrary => ({
  id: "lib", name: "Test Shows", type: "video", kind: "shows", scanStatus: "idle", lastScannedAt: "2026-11-14T22:56:00.000Z",
  engine: { online: true, metadata }
} as unknown as ManagedLibrary);

describe("a video library's metadata pass", () => {
  it("says it is running, and how far it is", () => {
    render(<LibraryStatus library={library({ state: "running", done: 12, total: 50, startedAt: "2026-11-14T23:00:00.000Z", tmdb: true })} scanning={false} videoEngineDown={false} />);
    expect(screen.getByText("Getting details…")).toBeTruthy();
    expect(screen.getByText("12 of 50 shows")).toBeTruthy();
  });

  it("says it is waiting behind another", () => {
    render(<LibraryStatus library={library({ state: "queued", done: 0, total: 0, startedAt: null, tmdb: true })} scanning={false} videoEngineDown={false} />);
    expect(screen.getByText("Waiting to get details")).toBeTruthy();
  });

  it("is up to date with none", () => {
    render(<LibraryStatus library={library(null)} scanning={false} videoEngineDown={false} />);
    expect(screen.getByText("Up to date")).toBeTruthy();
  });
});
