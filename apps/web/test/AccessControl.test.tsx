import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AccessControl } from "../src/shared/AccessControl";

// The one access editor (redesigned 2026-11-19): a card for public or private, one
// Add field with the role to give, the table of those who have access — a tick and a
// role menu each (the menu says what every role allows and ends in Remove access) —
// and what each role may do underneath. Without roles, Add gives access and each row
// has Remove.

const roles = [
  { value: "viewer", label: "Viewer", tagline: "Sees it", dot: "#3b82f6" },
  { value: "manager", label: "Manager", tagline: "Runs it", dot: "#f59e0b" }
];
const candidates = { users: [{ id: "u1", name: "Ann" }, { id: "u2", name: "Bo", sub: "bo@example.com" }], groups: [{ id: "g1", name: "Kids" }] };

describe("the access editor", () => {
  it("adds one person or group with the role chosen", async () => {
    const user = userEvent.setup();
    const onGrant = vi.fn();
    render(<AccessControl roles={roles} members={[{ subjectType: "user", subjectId: "u1", name: "Ann", role: "viewer" }]} candidates={candidates} onGrant={onGrant} onRevoke={() => {}} />);
    // Only those with access are listed.
    expect(screen.getByText("Ann")).toBeInTheDocument();
    expect(screen.queryByText("Bo")).not.toBeInTheDocument();
    // Add offers those who have none yet, groups first.
    await user.click(screen.getByRole("combobox", { name: "Add people or groups" }));
    const list = screen.getByRole("listbox");
    const options = within(list).getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent(/Kids.*Group/);
    expect(options[1]).toHaveTextContent(/Bo.*bo@example.com/);
    await user.type(screen.getByRole("combobox", { name: "Add people or groups" }), "bo");
    await user.click(screen.getByRole("option", { name: /Bo/ }));
    await user.click(screen.getByRole("button", { name: /^Role to give/ }));
    // The menu says what each role allows, beside its name.
    await user.click(screen.getByRole("menuitemradio", { name: /^Managers*Runs it$/ }));
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(onGrant).toHaveBeenCalledWith("user", "u2", "manager");
  });

  it("changes a role on the list, and Remove access takes it away", async () => {
    const user = userEvent.setup();
    const onGrant = vi.fn();
    const onRevoke = vi.fn();
    render(<AccessControl roles={roles} members={[{ subjectType: "group", subjectId: "g1", name: "Kids", role: "viewer" }]} candidates={candidates} onGrant={onGrant} onRevoke={onRevoke} />);
    await user.click(screen.getByRole("button", { name: /^Role for Kids: Viewer/ }));
    await user.click(screen.getByRole("menuitemradio", { name: /Manager/ }));
    expect(onGrant).toHaveBeenCalledWith("group", "g1", "manager");
    await user.click(screen.getByRole("button", { name: /^Role for Kids/ }));
    await user.click(screen.getByRole("menuitem", { name: "Remove access" }));
    expect(onRevoke).toHaveBeenCalledWith("group", "g1");
  });

  it("sets Deny apart in the menu and leaves it out of the roles underneath", async () => {
    const user = userEvent.setup();
    const withDeny = [...roles, { value: "deny", label: "Deny access", tagline: "Explicitly block access", dot: "#ef4444" }];
    render(<AccessControl roles={withDeny} members={[{ subjectType: "user", subjectId: "u1", name: "Ann", role: "viewer" }]} candidates={candidates} onGrant={() => {}} onRevoke={() => {}} />);
    expect(screen.getByText(/Roles/).closest(".ax-legend")).not.toHaveTextContent("Deny access");
    await user.click(screen.getByRole("button", { name: /^Role for Ann/ }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("separator")).toHaveLength(2);
    expect(within(menu).getByRole("menuitemradio", { name: /^Deny accesss*Explicitly block access$/ })).toBeInTheDocument();
  });

  it("changes every ticked row at once from the Access heading", async () => {
    const user = userEvent.setup();
    const onGrant = vi.fn();
    const onRevoke = vi.fn();
    const members = [
      { subjectType: "group" as const, subjectId: "g1", name: "Kids", role: "viewer" },
      { subjectType: "user" as const, subjectId: "u1", name: "Ann", role: "viewer" },
      { subjectType: "user" as const, subjectId: "u2", name: "Bo", role: "manager" }
    ];
    render(<AccessControl roles={roles} members={members} candidates={candidates} onGrant={onGrant} onRevoke={onRevoke} />);
    expect(screen.getByText("People and groups")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Select all" }));
    expect(screen.getByText("3 selected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Change access" }));
    await user.click(screen.getByRole("menuitemradio", { name: /Manager/ }));
    // Bo is a manager already: only the other two are sent, one after the other.
    await vi.waitFor(() => expect(onGrant.mock.calls).toEqual([["group", "g1", "manager"], ["user", "u1", "manager"]]));
    // The ticks are spent with the change.
    expect(screen.getByText("People and groups")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Select Ann" }));
    await user.click(screen.getByRole("button", { name: "Change access" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove access" }));
    await vi.waitFor(() => expect(onRevoke.mock.calls).toEqual([["user", "u1"]]));
  });

  it("says whether it is public, and spells out the roles", () => {
    render(<AccessControl roles={roles} members={[]} candidates={candidates}
      everyone={{ role: "viewer", hint: "Every signed-in member", summary: "Everyone can view this library." }} onGrant={() => {}} onRevoke={() => {}} />);
    expect(screen.getByText("Open to everyone")).toBeInTheDocument();
    expect(screen.getByText("Everyone can view this library.")).toBeInTheDocument();
    expect(screen.getByText(/Roles/).closest(".ax-legend")).toHaveTextContent("Roles:ViewerSees itManagerRuns it");
    expect(screen.getByText("Changes are saved automatically.")).toBeInTheDocument();
  });

  it("on/off: Add gives access and Remove takes it, as a list where the place saves one", async () => {
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
    // No role menus at all.
    expect(screen.queryByRole("button", { name: /^Role/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Add people or groups" }));
    await user.click(screen.getByRole("option", { name: /Bo/ }));
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(onGrantMany).toHaveBeenCalledWith([{ subjectType: "user", subjectId: "u2" }], "");
    expect(onGrant).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Remove Ann" }));
    expect(onRevoke).toHaveBeenCalledWith("user", "u1");
  });
});
