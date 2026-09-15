// The line over a map whose pieces could not be downloaded (shared/map/failure-banner.ts).
//
// What it must get right, and what a real map makes hard to see: a map is usually
// PART kept and part not, so tiles keep arriving from disk all the way through an
// outage. The line has to survive those, or it blinks on and off while the map
// service is still down.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFailureBanner, serviceIsDown } from "../src/shared/map/failure-banner";

describe("what counts as the map service being down", () => {
  it("takes the server's 502 and 503 — it could not reach the provider, or is leaving it alone", () => {
    expect(serviceIsDown({ status: 502 })).toBe(true);
    expect(serviceIsDown({ status: 503 })).toBe(true);
  });

  it("takes a request that never got an answer, which MapLibre marks status 0", () => {
    // What a browser with no connection, or a server that is not there, looks
    // like: "AJAXError: Failed to fetch (0)". Read from the real app — the first
    // version of this check only looked at 5xx and let these through in silence.
    expect(serviceIsDown({ status: 0, message: "Failed to fetch" })).toBe(true);
    expect(serviceIsDown(new Error("Failed to fetch"))).toBe(true);
    expect(serviceIsDown(new TypeError("NetworkError when attempting to fetch resource."))).toBe(true);
  });

  it("does not take an answer about one piece of map", () => {
    // A tile that does not exist says nothing about the service — and 404s are
    // ordinary: upstream has no tile for open ocean at every zoom.
    expect(serviceIsDown({ status: 404 })).toBe(false);
    expect(serviceIsDown({ status: 400 })).toBe(false);
    expect(serviceIsDown(new Error("style is not in a shape this version understands"))).toBe(false);
    expect(serviceIsDown(null)).toBe(false);
  });
});

describe("the line itself", () => {
  let container: HTMLElement;
  const text = () => "Some of this map couldn't be downloaded";
  const shown = () => container.querySelectorAll(".map-banner").length;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    container.remove();
  });

  it("goes up on the first failure, and says so to a screen reader", () => {
    const banner = createFailureBanner(container, text);
    expect(shown()).toBe(0);
    banner.failed();
    expect(shown()).toBe(1);
    expect(container.querySelector(".map-banner")?.getAttribute("role")).toBe("status");
    expect(container.querySelector(".map-banner")?.textContent).toBe(text());
  });

  it("is put up once, however many pieces fail", () => {
    const banner = createFailureBanner(container, text);
    for (let i = 0; i < 20; i += 1) banner.failed();
    expect(shown()).toBe(1);
  });

  it("stays while pieces keep arriving from what was already kept", () => {
    const banner = createFailureBanner(container, text);
    banner.failed();
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(1000);
      banner.arrived();
    }
    expect(shown()).toBe(1);
  });

  it("goes once the failures have stopped and the map is filling in again", () => {
    const banner = createFailureBanner(container, text);
    banner.failed();
    vi.advanceTimersByTime(11_000);
    banner.arrived();
    expect(shown()).toBe(0);
  });

  it("comes back when it fails again", () => {
    const banner = createFailureBanner(container, text);
    banner.failed();
    vi.advanceTimersByTime(11_000);
    banner.arrived();
    banner.failed();
    expect(shown()).toBe(1);
  });

  it("goes at once when the map does, whatever the failures were doing", () => {
    const banner = createFailureBanner(container, text);
    banner.failed();
    banner.remove();
    expect(shown()).toBe(0);
  });
});
