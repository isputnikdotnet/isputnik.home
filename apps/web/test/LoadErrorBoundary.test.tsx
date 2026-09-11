import { Suspense, lazy } from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoadErrorBoundary, isChunkLoadError } from "../src/shared/LoadErrorBoundary";

// The service worker precaches only the shell and the offline screens, so offline
// a lazy page that was never opened has no code to load. These pin down that such
// a failure becomes a message rather than a blank app — and that a real render
// bug is NOT dressed up as one.

function failingPage(error: Error) {
  return lazy(() => Promise.reject(error));
}

function Boom(): never {
  throw new Error("a genuine render bug");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LoadErrorBoundary", () => {
  it("recognises what each browser says when a chunk fails", () => {
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: /static/X.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("error loading dynamically imported module: /static/X.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError("not an error")).toBe(false);
  });

  it("shows a way out when a lazy page can't be downloaded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Page = failingPage(new TypeError("Failed to fetch dynamically imported module: /static/GalleryPage.js"));
    render(
      <LoadErrorBoundary resetKey="gallery">
        <Suspense fallback={<p>Loading…</p>}>
          <Page />
        </Suspense>
      </LoadErrorBoundary>
    );
    expect(await screen.findByText("Unable to open this page")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go home" })).toBeInTheDocument();
  });

  it("lets the next route render again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Page = failingPage(new TypeError("Failed to fetch dynamically imported module: /static/GalleryPage.js"));
    const { rerender } = render(
      <LoadErrorBoundary resetKey="gallery">
        <Suspense fallback={<p>Loading…</p>}>
          <Page />
        </Suspense>
      </LoadErrorBoundary>
    );
    await screen.findByText("Unable to open this page");
    rerender(
      <LoadErrorBoundary resetKey="home">
        <p>Home</p>
      </LoadErrorBoundary>
    );
    expect(screen.getByText("Home")).toBeInTheDocument();
    expect(screen.queryByText("Unable to open this page")).not.toBeInTheDocument();
  });

  it("does not swallow an ordinary render error", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(
        <LoadErrorBoundary resetKey="x">
          <Boom />
        </LoadErrorBoundary>
      )
    ).toThrow("a genuine render bug");
  });
});
