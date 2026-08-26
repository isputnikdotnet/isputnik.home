import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api")>();
  return { ...actual, api: vi.fn() };
});

// The sign-in screen decides two things from what the server told it before
// anyone typed anything: whether passkeys are worth offering, and whether a
// device can be linked from wherever this browser is. Both are "leave it out
// rather than show it and refuse", so both are worth holding in a test — an
// option that appears and then 403s teaches people to click through refusals.
import { LoginPage } from "../src/pages/LoginPage";

const noop = async () => {};

describe("the link-a-device entry point", () => {
  it("is offered when the server says a device may be linked from here", () => {
    render(<LoginPage onSignedIn={noop} passkeysAvailable={false} deviceLinkAvailable />);
    expect(screen.getByRole("button", { name: /link a tv or display/i })).toBeInTheDocument();
  });

  it("is absent when it isn't — outside the house with no window open", () => {
    render(<LoginPage onSignedIn={noop} passkeysAvailable={false} deviceLinkAvailable={false} />);
    expect(screen.queryByRole("button", { name: /link a tv or display/i })).not.toBeInTheDocument();
  });

  it("leaves the rest of the screen alone either way", () => {
    // The password form is the path everyone can take, and nothing about device
    // linking may take it away.
    render(<LoginPage onSignedIn={noop} passkeysAvailable={false} deviceLinkAvailable={false} />);
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^sign in$/i })).toBeInTheDocument();
  });
});
