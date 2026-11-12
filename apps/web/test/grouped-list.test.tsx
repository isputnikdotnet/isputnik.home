import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ActionRow, CheckRow, GroupedList, InfoRow, NavRow, ToggleRow } from "../src/shared/GroupedList";

// shared/GroupedList — the phone-Settings layout Device Sync is built from: the
// whole row is the target, a row that leads somewhere ends in a chevron, and its
// value sits on the right.
describe("GroupedList", () => {
  it("draws a titled group whose rows lead somewhere, say something, or act", async () => {
    const step = vi.fn();
    const act = vi.fn();
    render(
      <GroupedList title="Phones" note="Every member's phones.">
        <NavRow label="Anna's iPhone" sub="Anna" value="Backed up 2 hours ago" onClick={step} />
        <NavRow label="Logs" href="/control/infrastructure/logs" />
        <InfoRow label="Added" value="3 Nov" />
        <ActionRow tone="danger" label="Remove this phone" onClick={act} />
      </GroupedList>
    );
    expect(screen.getByRole("region", { name: "Phones" })).toBeInTheDocument();
    expect(screen.getByText("Every member's phones.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Anna's iPhone/ }));
    expect(step).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: /Logs/ })).toHaveAttribute("href", "/control/infrastructure/logs");
    // A row that only says something is not a control.
    expect(screen.queryByRole("button", { name: /Added/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove this phone" }));
    expect(act).toHaveBeenCalledOnce();
  });

  it("switches and ticks: the whole row is the control, saying its state", async () => {
    const toggle = vi.fn();
    const pick = vi.fn();
    render(
      <GroupedList>
        <ToggleRow label="Members may have one" checked={false} onChange={toggle} />
        <CheckRow label="Every member" checked onSelect={pick} />
        <CheckRow label="Only the members chosen" checked={false} onSelect={pick} />
      </GroupedList>
    );
    const sw = screen.getByRole("switch", { name: "Members may have one" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    await userEvent.click(sw);
    expect(toggle).toHaveBeenCalledWith(true);
    expect(screen.getByRole("button", { name: "Every member" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Only the members chosen" }));
    expect(pick).toHaveBeenCalledOnce();
  });
});
