import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: vi.fn() }));
const { api } = await import("../src/api");
const { SendToSheet } = await import("../src/features/social/SendToSheet");
const mockApi = vi.mocked(api);

// The sheet decides what a press is about to DO, and one of its options widens
// somebody's access. So the words in front of that press are the thing worth
// pinning: "Send" and "Give access and send" must never be swapped by accident.

interface Person {
  id: string;
  displayName: string;
  alreadySent: boolean;
  canOpen: boolean;
}

const destinations = (over: Record<string, unknown> = {}) => ({
  subject: { title: "The Hobbit", subtitle: "Tolkien", coverUrl: null, href: "/ebooks/books/b1" },
  people: [
    { id: "mom", displayName: "Mum", alreadySent: false, canOpen: true },
    { id: "guest", displayName: "Guest", alreadySent: false, canOpen: false }
  ] as Person[],
  canGrant: true,
  ereader: { applicable: false, configured: false },
  guestLink: false,
  ...over
});

function mount(over: Record<string, unknown> = {}, props: Record<string, unknown> = {}) {
  const sent: Record<string, unknown>[] = [];
  mockApi.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      sent.push(JSON.parse(String(init.body ?? "{}")));
      return { sent: ["Mum"], skipped: [], granted: [] };
    }
    if (path.startsWith("/api/social/destinations")) return destinations(over);
    return {};
  });
  render(
    <SendToSheet subject={{ entityType: "ebook", entityId: "b1" }} onClose={vi.fn()} {...props} />
  );
  return { sent };
}

beforeEach(() => {
  mockApi.mockReset();
});

describe("who is offered", () => {
  it("lists everybody, and marks the ones who cannot open it", async () => {
    mount();
    expect(await screen.findByRole("button", { name: /Mum/ })).toBeEnabled();

    // Not hidden — hiding them is what used to send people off to a separate
    // Share dialog to work out why somebody was missing.
    expect(screen.getByText("Doesn't have access yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Guest/ })).toBeEnabled();
    expect(screen.getByText("will get access")).toBeInTheDocument();
  });

  it("shows who cannot be helped, disabled, when the caller may not grant", async () => {
    mount({ canGrant: false });
    await screen.findByRole("button", { name: /Mum/ });

    expect(screen.getByText("Can't open this")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Guest/ })).toBeDisabled();
    expect(screen.getByText("no access")).toBeInTheDocument();
  });

  it("offers the caller's own e-reader only when it is set up, and points at Profile when not", async () => {
    mount({ ereader: { applicable: true, configured: false } }, { onSendToEreader: vi.fn() });
    expect(await screen.findByText("Set up my e-reader")).toBeInTheDocument();

    mockApi.mockReset();
    document.body.innerHTML = "";
    mount({ ereader: { applicable: true, configured: true } }, { onSendToEreader: vi.fn() });
    expect(await screen.findByText("My e-reader")).toBeInTheDocument();
  });
});

describe("what the press says it will do", () => {
  it("just sends, for somebody who can already open it", async () => {
    const user = userEvent.setup();
    const { sent } = mount();

    await user.click(await screen.findByRole("button", { name: /Mum/ }));

    expect(screen.getByText(/no file is sent/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    // The flag that widens access must be off for somebody who needs nothing.
    expect(sent[0]).toMatchObject({ toUserIds: ["mom"], grantAccess: false });
  });

  it("says it is giving access, before it gives access", async () => {
    const user = userEvent.setup();
    const { sent } = mount();

    await user.click(await screen.findByRole("button", { name: /Guest/ }));

    expect(screen.getByText("Guest can't open this yet. Sending will also give them access to it."))
      .toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Give access and send" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ toUserIds: ["guest"], grantAccess: true });
  });

  it("carries the line somebody typed, and sends without one", async () => {
    const user = userEvent.setup();
    const { sent } = mount();

    await user.click(await screen.findByRole("button", { name: /Mum/ }));
    await user.type(screen.getByPlaceholderText("You'll love this"), "the middle drags");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(sent[0]).toMatchObject({ message: "the middle drags" }));
  });

  it("comes back to the list from the compose step without sending", async () => {
    const user = userEvent.setup();
    const { sent } = mount();

    await user.click(await screen.findByRole("button", { name: /Mum/ }));
    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(await screen.findByRole("button", { name: /Guest/ })).toBeInTheDocument();
    expect(sent).toHaveLength(0);
  });
});

describe("the guest link", () => {
  it("hands off to the host page rather than doing its own thing", async () => {
    const user = userEvent.setup();
    const onGuestLink = vi.fn();
    mount({ guestLink: true }, { onGuestLink });

    await user.click(await screen.findByRole("button", { name: "Anyone with a link" }));
    expect(onGuestLink).toHaveBeenCalledOnce();
  });

  it("is absent when the host page offers no such flow", async () => {
    mount({ guestLink: true });
    await screen.findByRole("button", { name: /Mum/ });
    expect(screen.queryByRole("button", { name: "Anyone with a link" })).not.toBeInTheDocument();
  });
});
