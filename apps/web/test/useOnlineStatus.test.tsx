import { render, screen, waitFor, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnectionStatus, useOnlineStatus, resetConnectionProbe } from "../src/pwa/useOnlineStatus";

// One probe for the whole app: every component that asks about the connection reads
// the same answer, and the server is asked once per interval however many are
// mounted. Before this the hook ran a timer per consumer, so an ordinary screen
// asked twice every six seconds.

const PROBE = "/api/setup/status";

function Reader({ label }: { label: string }) {
  const status = useConnectionStatus();
  return <span data-testid={label}>{status}</span>;
}

function BoolReader() {
  return <span data-testid="bool">{String(useOnlineStatus())}</span>;
}

let probes: number;
let respond: () => Response;

function setOnline(value: boolean): void {
  Object.defineProperty(navigator, "onLine", { value, configurable: true });
}

function setVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { value, configurable: true });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  probes = 0;
  respond = () => new Response("{}", { status: 200 });
  setOnline(true);
  setVisibility("visible");
  vi.mocked(globalThis.fetch).mockImplementation(async (input: RequestInfo | URL) => {
    if (String(input).startsWith(PROBE)) {
      probes += 1;
      return respond();
    }
    throw new Error(`unexpected fetch: ${String(input)}`);
  });
});

afterEach(() => {
  resetConnectionProbe();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the connection probe", () => {
  it("asks the server once however many components are watching", async () => {
    render(<><Reader label="a" /><Reader label="b" /><BoolReader /></>);
    await waitFor(() => expect(probes).toBe(1));

    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(probes).toBe(2);

    expect(screen.getByTestId("a")).toHaveTextContent("online");
    expect(screen.getByTestId("b")).toHaveTextContent("online");
    expect(screen.getByTestId("bool")).toHaveTextContent("true");
  });

  it("stops asking once the last watcher goes away, and starts again for a new one", async () => {
    const first = render(<Reader label="a" />);
    await waitFor(() => expect(probes).toBe(1));

    first.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(probes).toBe(1); // nothing is watching: no timer, no requests

    render(<Reader label="c" />);
    await waitFor(() => expect(probes).toBe(2));
  });

  it("tells everyone at once when the server stops answering", async () => {
    render(<><Reader label="a" /><Reader label="b" /></>);
    await waitFor(() => expect(probes).toBe(1));

    respond = () => new Response("nope", { status: 500 });
    // One miss is tolerated (a scan or a restart); the second declares it.
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(screen.getByTestId("a")).toHaveTextContent("online");
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });

    await waitFor(() => expect(screen.getByTestId("a")).toHaveTextContent("unreachable"));
    expect(screen.getByTestId("b")).toHaveTextContent("unreachable");
  });

  it("says offline without asking when the device has no network", async () => {
    render(<Reader label="a" />);
    await waitFor(() => expect(probes).toBe(1));

    setOnline(false);
    await act(async () => { window.dispatchEvent(new Event("offline")); });
    expect(screen.getByTestId("a")).toHaveTextContent("offline");

    const before = probes;
    await act(async () => { await vi.advanceTimersByTimeAsync(12000); });
    expect(probes).toBe(before); // no point asking a server we can't reach
  });

  it("leaves a hidden tab alone and catches up when it comes back", async () => {
    render(<Reader label="a" />);
    await waitFor(() => expect(probes).toBe(1));

    setVisibility("hidden");
    await act(async () => { await vi.advanceTimersByTimeAsync(18000); });
    expect(probes).toBe(1);

    setVisibility("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await waitFor(() => expect(probes).toBe(2));
  });
});
