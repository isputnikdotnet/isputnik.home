import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// Unmount between tests so a leaked component can't be found by the next one.
afterEach(cleanup);

// jsdom has no layout engine, and several components measure a trigger to place
// a popover next to it. Without this they throw on a missing method rather than
// failing on the thing under test.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}
if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  }) as unknown as MediaQueryList;
}

// Nothing in a unit test should reach the network. Anything that tries gets a
// loud failure naming the URL, rather than a timeout or an unhandled rejection.
globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
  throw new Error(
    `Unmocked fetch to ${String(input)} — mock the api module (vi.mock) or stub fetch in this test.`
  );
}) as unknown as typeof fetch;
