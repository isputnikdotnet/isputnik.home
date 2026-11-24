// The chain-of-checks picture (Device Sync's "How phone backup works"): what sets
// out, each check with how it stands here, where a No leads — and, when a check is
// stopping something, a way out that is a button to the fix.
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CheckChain, type ChainCheck } from "../src/features/control/CheckChain";

const chain = (checks: ChainCheck[]) => render(
  <CheckChain
    icon={null}
    title="How phone backup works"
    body="Each photo passes four checks."
    aria="The whole chain, said in a sentence."
    learnHref="/help/phone-sync-setup"
    learnLabel="Learn more"
    exitLabel="No"
    source={{ icon: null, title: "Phone", sub: "2 set up" }}
    end={{ icon: null, title: "Personal library", sub: "1 phone backing up" }}
    checks={checks}
  />
);

describe("CheckChain", () => {
  it("draws the source, every check in order, then the arrival", () => {
    chain([
      { question: "Allowed network?", status: "2 networks allowed", tone: "ok", exit: "Refused", exitNote: "Add its network" },
      { question: "New photo?", status: "Never stored twice", tone: "plain", exit: "Skipped", exitNote: "Already on the server" }
    ]);
    const steps = within(screen.getByRole("list", { name: "The whole chain, said in a sentence." })).getAllByRole("listitem");
    expect(steps.map((step) => step.querySelector("strong")?.textContent)).toEqual(["Phone", "Allowed network?", "New photo?", "Personal library"]);
    expect(steps[1]).toHaveClass("is-ok");
    expect(steps[2]).toHaveClass("is-plain");
    expect(steps[1]).toHaveTextContent("2 networks allowed");
    expect(steps[3]).toHaveTextContent("1 phone backing up");
    expect(screen.getByRole("link", { name: "Learn more" })).toHaveAttribute("href", "/help/phone-sync-setup");
  });

  it("makes the way out a button only for a check with a fix", async () => {
    const onFix = vi.fn();
    chain([
      { question: "Allowed network?", status: "1 phone stopped here", tone: "warn", exit: "Refused", exitNote: "Add its network", onFix },
      { question: "Signed in?", status: "With the phone's own password", tone: "plain", exit: "Asked to sign in", exitNote: "Until its password is entered" }
    ]);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent("Refused");
    expect(buttons[0]).toHaveTextContent("Add its network");
    await userEvent.click(buttons[0]);
    expect(onFix).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Allowed network?").closest("li")).toHaveClass("is-warn");
  });
});
