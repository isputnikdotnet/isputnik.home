import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", () => ({ api: vi.fn() }));
const { api } = await import("../src/api");
const { NotificationsSection } = await import("../src/features/control/sections/NotificationsSection");
const mockApi = vi.mocked(api);

// The tab's whole job is consent, so the states that matter are: off by default,
// and inert while there is no mail server to send through. The server enforces
// the second one too — this is the half that explains it.

function mount(over: { shareNotifications?: boolean; mailConfigured?: boolean } = {}) {
  const state = { shareNotifications: false, mailConfigured: false, ...over };
  mockApi.mockImplementation(async (_path: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body ?? "{}")) as { shareNotifications: boolean };
      state.shareNotifications = body.shareNotifications;
      return { notifications: { shareNotifications: state.shareNotifications }, mailConfigured: state.mailConfigured };
    }
    return { notifications: { shareNotifications: state.shareNotifications }, mailConfigured: state.mailConfigured };
  });
  render(<NotificationsSection />);
  return state;
}

const shareBox = () => screen.getByRole("checkbox");
const saveButton = () => screen.getByRole("button", { name: /Save/ });

beforeEach(() => mockApi.mockReset());

describe("notifications tab", () => {
  it("starts switched off", async () => {
    mount({ mailConfigured: true });
    await waitFor(() => expect(shareBox()).toBeInTheDocument());
    expect(shareBox()).not.toBeChecked();
  });

  it("greys everything out and says why when there is no mail server", async () => {
    mount({ mailConfigured: false });
    await waitFor(() => expect(shareBox()).toBeInTheDocument());

    expect(screen.getByText(/No email server yet/)).toBeInTheDocument();
    // Disabled via the fieldset, so the input's own attribute is not the question.
    expect(shareBox()).toBeDisabled();
    expect(saveButton()).toBeDisabled();
    expect(screen.getByRole("link", { name: /Settings → Email/ })).toHaveAttribute(
      "href",
      "/control/settings/email"
    );
  });

  it("shows a stored ON as off while mail is missing — nothing can be sent either way", async () => {
    // The switch survives the mail server going away; the tab must not imply otherwise.
    mount({ shareNotifications: true, mailConfigured: false });
    await waitFor(() => expect(shareBox()).toBeInTheDocument());
    expect(shareBox()).not.toBeChecked();
  });

  it("lets it be switched on and saved once mail is configured", async () => {
    const user = userEvent.setup();
    const state = mount({ mailConfigured: true });
    await waitFor(() => expect(shareBox()).toBeInTheDocument());

    expect(screen.queryByText(/No email server yet/)).not.toBeInTheDocument();
    expect(shareBox()).toBeEnabled();

    await user.click(shareBox());
    await user.click(saveButton());

    await waitFor(() => expect(screen.getByText("Notification settings updated.")).toBeInTheDocument());
    expect(state.shareNotifications).toBe(true);
    expect(shareBox()).toBeChecked();
  });

  it("reports a refusal from the server rather than pretending it saved", async () => {
    const user = userEvent.setup();
    mount({ mailConfigured: true });
    await waitFor(() => expect(shareBox()).toBeInTheDocument());

    mockApi.mockRejectedValueOnce(new Error("Set up an email server first — there is nowhere to send notifications."));
    await user.click(shareBox());
    await user.click(saveButton());

    await waitFor(() => expect(screen.getByText(/Set up an email server first/)).toBeInTheDocument());
    expect(screen.queryByText("Notification settings updated.")).not.toBeInTheDocument();
  });
});
