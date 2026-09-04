import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: vi.fn() }));
const { api } = await import("../src/api");
const { SendToSheet } = await import("../src/features/social/SendToSheet");
const mockApi = vi.mocked(api);

// The sheet decides what a press is about to DO, and one of its options widens
// somebody's access. So the words in front of that press are the thing worth
// pinning: "Send" and "Give access and send" must never be swapped by accident.
//
// Picking people is a multi-select now, so the second thing worth pinning is
// that one person who needs access is enough to turn the whole send into a
// grant — and that it says so before it does it.

interface Person {
  id: string;
  displayName: string;
  email: string;
  alreadySent: boolean;
  canOpen: boolean;
}

const destinations = (over: Record<string, unknown> = {}) => ({
  subject: { title: "The Hobbit", subtitle: "Tolkien", coverUrl: null, href: "/ebooks/books/b1" },
  people: [
    { id: "mom", displayName: "Mum", email: "mum@home.local", alreadySent: false, canOpen: true },
    { id: "guest", displayName: "Guest", email: "guest@home.local", alreadySent: false, canOpen: false }
  ] as Person[],
  canGrant: true,
  ereader: { applicable: false, configured: false },
  guestLink: false,
  manageLinks: false,
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

/** Tick people, then press the button that carries the send to the compose step. */
async function pick(user: ReturnType<typeof userEvent.setup>, ...names: RegExp[]) {
  for (const name of names) {
    await user.click(await screen.findByRole("button", { name }));
  }
  await user.click(screen.getByRole("button", { name: /^Send to / }));
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

  it("offers no send button until somebody is ticked", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("button", { name: /Mum/ });
    expect(screen.queryByRole("button", { name: /^Send to / })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Mum/ }));
    expect(screen.getByRole("button", { name: "Send to 1 person" })).toBeInTheDocument();

    // And ticking again puts it back.
    await user.click(screen.getByRole("button", { name: /Mum/ }));
    expect(screen.queryByRole("button", { name: /^Send to / })).not.toBeInTheDocument();
  });

  it("offers the caller's own e-reader only when it is set up, and points at Profile when not", async () => {
    const user = userEvent.setup();
    mount({ ereader: { applicable: true, configured: false } }, { onSendToEreader: vi.fn() });
    await user.click(await screen.findByRole("tab", { name: /E-reader/ }));
    // Asserted on the panel, never on the tile: the tile's caption says the same
    // words in both states, so testing it would prove nothing about either.
    expect(screen.getByRole("link", { name: "Add your device address first" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Send to my e-reader/ })).not.toBeInTheDocument();

    mockApi.mockReset();
    document.body.innerHTML = "";
    mount({ ereader: { applicable: true, configured: true } }, { onSendToEreader: vi.fn() });
    await user.click(await screen.findByRole("tab", { name: /E-reader/ }));
    expect(screen.getByRole("button", { name: /Send to my e-reader/ })).toBeInTheDocument();
  });

  it("sends to the e-reader through the host page's own handler", async () => {
    const user = userEvent.setup();
    const onSendToEreader = vi.fn().mockResolvedValue(undefined);
    mount({ ereader: { applicable: true, configured: true } }, { onSendToEreader });

    await user.click(await screen.findByRole("tab", { name: /E-reader/ }));
    await user.click(screen.getByRole("button", { name: /Send to my e-reader/ }));

    await waitFor(() => expect(onSendToEreader).toHaveBeenCalledOnce());
    expect(await screen.findByText(/your e-reader/)).toBeInTheDocument();
  });
});

describe("what the press says it will do", () => {
  it("just sends, for somebody who can already open it", async () => {
    const user = userEvent.setup();
    const { sent } = mount();

    await pick(user, /Mum/);

    expect(screen.getByText(/no file is sent/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    // The flag that widens access must be off for somebody who needs nothing.
    expect(sent[0]).toMatchObject({ toUserIds: ["mom"], grantAccess: false });
  });

  it("says it is giving access, before it gives access", async () => {
    const user = userEvent.setup();
    const { sent } = mount();

    await pick(user, /Guest/);

    expect(screen.getByText("1 of them can't open this yet. Sending will also give them access."))
      .toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Give access and send" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ toUserIds: ["guest"], grantAccess: true });
  });

  it("treats a mixed selection as a grant, and says so", async () => {
    const user = userEvent.setup();
    const { sent } = mount();

    await pick(user, /Mum/, /Guest/);

    // One of the two needs access, so the whole send is a grant — anything less
    // would silently drop half the recipients.
    expect(screen.getByText("1 of them can't open this yet. Sending will also give them access."))
      .toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Give access and send" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ toUserIds: ["mom", "guest"], grantAccess: true });
  });

  it("carries the line somebody typed, and sends without one", async () => {
    const user = userEvent.setup();
    const { sent } = mount();

    await pick(user, /Mum/);
    await user.type(screen.getByPlaceholderText("You'll love this"), "the middle drags");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(sent[0]).toMatchObject({ message: "the middle drags" }));
  });

  it("comes back to the list from the compose step without sending", async () => {
    const user = userEvent.setup();
    const { sent } = mount();

    await pick(user, /Mum/);
    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(await screen.findByRole("button", { name: /Guest/ })).toBeInTheDocument();
    expect(sent).toHaveLength(0);
  });

  it("names anybody the server could not send to", async () => {
    const user = userEvent.setup();
    mockApi.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") return { sent: ["Mum"], skipped: ["Guest"], granted: [] };
      if (path.startsWith("/api/social/destinations")) return destinations();
      return {};
    });
    render(<SendToSheet subject={{ entityType: "ebook", entityId: "b1" }} onClose={vi.fn()} />);

    await pick(user, /Mum/, /Guest/);
    await user.click(screen.getByRole("button", { name: "Give access and send" }));

    expect(await screen.findByText(/Guest couldn't be sent to/)).toBeInTheDocument();
  });
});

describe("the guest link", () => {
  // The separate Share dialog is gone, so this tab has to do the work itself:
  // handing off was the trip that made "who can already see this" two places.
  it("creates the link in place, without leaving the dialog", async () => {
    const user = userEvent.setup();
    const calls: Array<{ path: string; body: unknown }> = [];
    mockApi.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        calls.push({ path, body: JSON.parse(String(init.body ?? "{}")) });
        return { share: { id: "s1", label: "For Dad", expiresAt: "2026-10-04", url: "https://home/lnk/abc" } };
      }
      if (path.startsWith("/api/social/destinations")) return destinations({ guestLink: true, manageLinks: true });
      if (path === "/api/shares") return { shares: [] };
      if (path.startsWith("/api/shares/user")) return { shares: [] };
      return {};
    });
    render(<SendToSheet subject={{ entityType: "ebook", entityId: "b1" }} onClose={vi.fn()} />);

    await user.click(await screen.findByRole("tab", { name: /Share link/ }));
    await user.type(screen.getByPlaceholderText("e.g. For Dad"), "For Dad");
    await user.click(screen.getByRole("button", { name: /Create link/ }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ path: "/api/shares", body: { bookId: "b1", label: "For Dad" } });
    // The address exists exactly once — only its hash is stored — so the dialog
    // has to put it in front of the user then and there.
    expect(await screen.findByDisplayValue("https://home/lnk/abc")).toBeInTheDocument();
  });

  // Stories and albums used to leave this dialog for one of their own here. They
  // mint on their own paths, which is the only thing that ever differed — so the
  // tab speaks those paths instead, and there is nowhere left to be sent.
  it.each([
    ["story", "s1", "/api/shares/story", "storyId"],
    ["gallery_album", "a1", "/api/shares/album", "albumId"]
  ])("mints a %s link in place, on its own endpoint", async (entityType, entityId, path, key) => {
    const user = userEvent.setup();
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    mockApi.mockImplementation(async (called: string, init?: RequestInit) => {
      if (init?.method === "POST" && called.startsWith("/api/shares")) {
        calls.push({ path: called, body: JSON.parse(String(init.body ?? "{}")) });
        return { share: { id: "l1", url: "https://home/lnk/xyz" } };
      }
      if (called.startsWith("/api/social/destinations")) {
        return destinations({ guestLink: true, manageLinks: true });
      }
      return { shares: [], recipients: [] };
    });
    render(<SendToSheet subject={{ entityType, entityId }} onClose={vi.fn()} />);

    await user.click(await screen.findByRole("tab", { name: /Share link/ }));
    await user.click(screen.getByRole("button", { name: /Create link/ }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].path).toBe(path);
    expect(calls[0].body[key]).toBe(entityId);
    expect(await screen.findByDisplayValue("https://home/lnk/xyz")).toBeInTheDocument();
  });

  it("offers a story's expand-albums choice, and nothing else's", async () => {
    const user = userEvent.setup();
    mount({ guestLink: true, manageLinks: true }, { subject: { entityType: "story", entityId: "s1" } });
    await user.click(await screen.findByRole("tab", { name: /Share link/ }));
    expect(screen.getByRole("checkbox")).toBeInTheDocument();

    cleanup();
    mount({ guestLink: true, manageLinks: true });
    await user.click(await screen.findByRole("tab", { name: /Share link/ }));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("is absent when there is no link flow at all", async () => {
    mount({ guestLink: true });
    await screen.findByRole("button", { name: /Mum/ });
    expect(screen.queryByRole("tab", { name: /Share link/ })).not.toBeInTheDocument();
  });
});
