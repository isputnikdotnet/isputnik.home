import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: vi.fn() }));
vi.mock("@simplewebauthn/browser", () => ({
  startRegistration: vi.fn(),
  browserSupportsWebAuthn: vi.fn(() => true)
}));

const { api } = await import("../src/api");
const { startRegistration, browserSupportsWebAuthn } = await import("@simplewebauthn/browser");
const { PasskeysSection } = await import("../src/features/profile/PasskeysSection");

const mockApi = vi.mocked(api);
const mockStartRegistration = vi.mocked(startRegistration);
const mockSupported = vi.mocked(browserSupportsWebAuthn);

// Two things this panel has to get right: never offer a button that can't work
// (a plain-http install has no WebAuthn to call), and be honest that removing a
// passkey doesn't lock anyone out.

interface Passkey {
  id: string;
  label: string | null;
  createdAt: string;
  lastUsed: string | null;
  backedUp: boolean;
}

function passkey(over: Partial<Passkey> = {}): Passkey {
  return {
    id: "pk1",
    label: "iPhone",
    createdAt: "2026-08-01T10:00:00.000Z",
    lastUsed: null,
    backedUp: true,
    ...over
  };
}

function mount(over: { available?: boolean; passkeys?: Passkey[] } = {}) {
  const state = { available: true, passkeys: [] as Passkey[], ...over };
  mockApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      state.passkeys = state.passkeys.filter((row) => !path.endsWith(row.id));
      return { ok: true };
    }
    if (path.endsWith("/options")) return { options: { challenge: "c" } };
    if (init?.method === "POST") return { id: "pk-new" };
    return { available: state.available, passkeys: state.passkeys };
  });
  render(<PasskeysSection />);
  return state;
}

beforeEach(() => {
  mockApi.mockReset();
  mockStartRegistration.mockReset();
  mockSupported.mockReturnValue(true);
});

describe("passkeys panel", () => {
  it("invites you to add one when there are none", async () => {
    mount();
    await waitFor(() => expect(screen.getByRole("button", { name: /Add passkey/ })).toBeInTheDocument());
    expect(screen.getByText(/No passkeys yet/)).toBeInTheDocument();
  });

  it("lists a passkey with when it was added and that it hasn't been used", async () => {
    mount({ passkeys: [passkey()] });
    await waitFor(() => expect(screen.getByText("iPhone")).toBeInTheDocument());
    expect(screen.getByText(/never used/)).toBeInTheDocument();
  });

  it("warns when a passkey lives on one device only", async () => {
    mount({ passkeys: [passkey({ backedUp: false })] });
    await waitFor(() => expect(screen.getByText(/this device only/)).toBeInTheDocument());
  });

  it("explains itself instead of offering a button the server can't honour", async () => {
    mount({ available: false });
    await waitFor(() => expect(screen.getByText(/aren't available on this server/i)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Add passkey/ })).not.toBeInTheDocument();
  });

  it("says so when the browser is the one that can't", async () => {
    mockSupported.mockReturnValue(false);
    mount();
    await waitFor(() => expect(screen.getByText(/browser can't use passkeys/i)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Add passkey/ })).not.toBeInTheDocument();
  });

  it("asks for the password before starting the device prompt", async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(screen.getByRole("button", { name: /Add passkey/ })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /Add passkey/ }));
    expect(screen.getByLabelText(/Current password/)).toBeInTheDocument();
    // Nothing has been asked of the authenticator yet — the password comes first.
    expect(mockStartRegistration).not.toHaveBeenCalled();
  });

  it("doesn't report a cancelled device prompt as a failure to explain", async () => {
    const user = userEvent.setup();
    mount();
    await waitFor(() => expect(screen.getByRole("button", { name: /Add passkey/ })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Add passkey/ }));

    const cancelled = new Error("The operation either timed out or was not allowed.");
    cancelled.name = "NotAllowedError";
    mockStartRegistration.mockRejectedValueOnce(cancelled);

    await user.type(screen.getByLabelText(/Current password/), "hunter2hunter2");
    // The panel's own button and the modal's submit share a name, which is right for
    // the user and ambiguous here — the submit is the one that starts the ceremony.
    const submit = screen
      .getAllByRole("button", { name: /^Add passkey$/ })
      .find((button) => button.getAttribute("type") === "submit")!;
    await user.click(submit);

    await waitFor(() => expect(screen.getByText(/cancelled before your device finished/i)).toBeInTheDocument());
  });

  it("promises the fallbacks still work before removing one", async () => {
    const user = userEvent.setup();
    mount({ passkeys: [passkey()] });
    await waitFor(() => expect(screen.getByText("iPhone")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /Remove iPhone/ }));
    expect(screen.getByText(/Remove "iPhone"\?/)).toBeInTheDocument();
    expect(screen.getByText(/password and two-factor sign-in still work/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Remove passkey/ }));
    await waitFor(() => expect(screen.queryByText("iPhone")).not.toBeInTheDocument());
  });
});
