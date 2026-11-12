import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({
  api: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(message: string, public status = 400, public body: unknown = {}) {
      super(message);
    }
  }
}));
vi.mock("../src/app/Shell", () => ({ Shell: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
const { api } = await import("../src/api");
const { DeviceLinkConfirmPage } = await import("../src/pages/DeviceLinkConfirmPage");
const mockApi = vi.mocked(api);

// A phone that scans the TV's QR signed out used to be sent to the sign-in page,
// then asked for the same password again to approve. Now the link page signs in
// itself, through the real sign-in endpoints, and approves with that one password.
const calls = () => mockApi.mock.calls.map(([path, init]) => [path, init?.body ? JSON.parse(String(init.body)) : undefined]);

beforeEach(() => { mockApi.mockReset(); });

describe("DeviceLinkConfirmPage signed out", () => {
  it("shows the TV's code from the address and asks the server nothing", () => {
    render(<DeviceLinkConfirmPage userCode="abcd2345" signedIn={false} onSignedIn={vi.fn()} />);
    expect(screen.getByText("ABCD-2345")).toBeInTheDocument();
    expect(mockApi).not.toHaveBeenCalled();
  });

  it("signs in and approves with the one password", async () => {
    mockApi.mockResolvedValueOnce({}).mockResolvedValueOnce({ ok: true });
    const onSignedIn = vi.fn().mockResolvedValue(undefined);
    render(<DeviceLinkConfirmPage userCode="ABCD2345" signedIn={false} onSignedIn={onSignedIn} />);
    await userEvent.type(screen.getByLabelText("Email"), "a@b.example");
    await userEvent.type(screen.getByLabelText("Password"), "secret-pass");
    await userEvent.click(screen.getByRole("button", { name: "Sign in and link" }));

    await screen.findByText("Device authorized");
    expect(calls()).toEqual([
      ["/api/auth/login", { email: "a@b.example", password: "secret-pass" }],
      ["/api/auth/device/ABCD2345/approve", { currentPassword: "secret-pass" }]
    ]);
    // The app hears about the new session only when the person leaves the page.
    expect(onSignedIn).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
  });

  it("asks for the second factor on the same page, then approves", async () => {
    mockApi
      .mockResolvedValueOnce({ mfaRequired: true, method: "totp" })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ ok: true });
    render(<DeviceLinkConfirmPage userCode="ABCD2345" signedIn={false} onSignedIn={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Email"), "a@b.example");
    await userEvent.type(screen.getByLabelText("Password"), "secret-pass");
    await userEvent.click(screen.getByRole("button", { name: "Sign in and link" }));

    await userEvent.type(await screen.findByLabelText(/code/i), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));

    await screen.findByText("Device authorized");
    expect(calls()).toEqual([
      ["/api/auth/login", { email: "a@b.example", password: "secret-pass" }],
      ["/api/auth/mfa/verify", { token: "123456" }],
      ["/api/auth/device/ABCD2345/approve", { currentPassword: "secret-pass" }]
    ]);
  });

  it("a refused sign-in never reaches the approval", async () => {
    mockApi.mockRejectedValueOnce(new Error("Invalid email or password"));
    render(<DeviceLinkConfirmPage userCode="ABCD2345" signedIn={false} onSignedIn={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Email"), "a@b.example");
    await userEvent.type(screen.getByLabelText("Password"), "wrong-pass");
    await userEvent.click(screen.getByRole("button", { name: "Sign in and link" }));

    await screen.findByText("Invalid email or password");
    expect(calls().map(([path]) => path)).toEqual(["/api/auth/login"]);
  });
});
