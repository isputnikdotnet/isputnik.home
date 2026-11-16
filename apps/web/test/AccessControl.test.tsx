import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AccessControl } from "../src/shared/AccessControl";

// The one access window: one list of everyone, a search and a filter. With roles,
// a role menu per row and tick boxes to set several at once; on/off, the tick box
// is the access itself.

const roles = [
  { value: "viewer", label: "Viewer", tagline: "Sees it", dot: "#3b82f6" },
  { value: "manager", label: "Manager", tagline: "Runs it", dot: "#f59e0b" }
];
const candidates = { users: [{ id: "u1", name: "Ann" }, { id: "u2", name: "Bo" }], groups: [{ id: "g1", name: "Kids" }] };

describe("the access window", () => {
  it("with roles: sets everyone ticked, one after another, to the role chosen", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    let inFlight = 0;
    let overlapped = false;
    const onGrant = async (type: "user" | "group", id: string, role: string) => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      calls.push(`${type}:${id}:${role}`);
      inFlight -= 1;
    };
    render(<AccessControl roles={roles} members={[]} candidates={candidates} onGrant={onGrant} onRevoke={() => {}} />);
    // Everyone is listed, with No access until given something; no Add tab.
    expect(screen.getByRole("button", { name: /^Role for Bo: No access/ })).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Select all shown" }));
    await user.click(screen.getByRole("button", { name: /^Role to give/ }));
    await user.click(screen.getByRole("option", { name: /Manager/ }));
    await user.click(screen.getByRole("button", { name: /Apply to selected/ }));
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls).toEqual(["group:g1:manager", "user:u1:manager", "user:u2:manager"]);
    expect(overlapped).toBe(false);
  });

  it("on/off: the tick box is the access, and the header's box gives it to all shown", async () => {
    const user = userEvent.setup();
    const onGrant = vi.fn();
    const onRevoke = vi.fn();
    const onGrantMany = vi.fn();
    render(
      <AccessControl
        roles={[]}
        members={[{ subjectType: "user", subjectId: "u1", name: "Ann", role: "" }]}
        candidates={candidates}
        onGrant={onGrant}
        onGrantMany={onGrantMany}
        onRevoke={onRevoke}
      />
    );
    // No menus, no Apply bar: ticking is giving.
    expect(screen.queryByRole("button", { name: /^Role for/ })).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Access for Ann" })).toBeChecked();
    await user.click(screen.getByRole("switch", { name: "Access for Bo" }));
    expect(onGrant).toHaveBeenCalledWith("user", "u2", "");
    await user.click(screen.getByRole("switch", { name: "Access for Ann" }));
    expect(onRevoke).toHaveBeenCalledWith("user", "u1");
    // The header: everyone shown without access, in one go.
    await user.click(screen.getByRole("switch", { name: "Give access to everyone shown" }));
    expect(onGrantMany).toHaveBeenCalledWith([{ subjectType: "group", subjectId: "g1" }, { subjectType: "user", subjectId: "u2" }], "");
    expect(screen.queryByRole("button", { name: /Apply to selected/ })).not.toBeInTheDocument();
  });
});
