import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AccessControl } from "../src/shared/AccessControl";

// The one access window: Add with several ticked grants every one of them, each
// waiting for the last to finish, so no grant is lost to another still in flight.

describe("the access window", () => {
  it("grants everyone ticked, one after another, with the role chosen", async () => {
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
    render(
      <AccessControl
        roles={[
          { value: "viewer", label: "Viewer", tagline: "Sees it", dot: "#3b82f6" },
          { value: "manager", label: "Manager", tagline: "Runs it", dot: "#f59e0b" }
        ]}
        members={[]}
        candidates={{ users: [{ id: "u1", name: "Ann" }, { id: "u2", name: "Bo" }], groups: [{ id: "g1", name: "Kids" }] }}
        onGrant={onGrant}
        onRevoke={() => {}}
      />
    );
    await user.click(screen.getByRole("tab", { name: "Add" }));
    for (const box of screen.getAllByRole("checkbox")) await user.click(box);
    await user.click(screen.getByRole("button", { name: /^Role to give: Viewer/ }));
    await user.click(screen.getByRole("option", { name: /Manager/ }));
    await user.click(screen.getByRole("button", { name: "Add 3" }));
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls).toEqual(["group:g1:manager", "user:u1:manager", "user:u2:manager"]);
    expect(overlapped).toBe(false);
  });
});
