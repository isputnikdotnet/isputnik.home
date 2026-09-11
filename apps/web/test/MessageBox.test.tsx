import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "../src/shared/Button";
import { MessageBox } from "../src/shared/MessageBox";

// MessageBox is the one inline notice — no custom error divs. What it owes a
// reader: an error interrupts (role=alert), everything else is a polite live
// region (role=status); the title says what happened and the body explains it;
// the icon is decoration and never part of what a screen reader reads.

describe("MessageBox", () => {
  it("announces an error as an alert", () => {
    render(<MessageBox tone="error" title="Unable to save">The name is already taken.</MessageBox>);
    const box = screen.getByRole("alert");
    expect(box).toHaveClass("message-box", "error");
    expect(box).toHaveTextContent("Unable to save");
    expect(box).toHaveTextContent("The name is already taken.");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it.each(["info", "warning", "success"] as const)("announces a %s notice as a polite status", (tone) => {
    render(<MessageBox tone={tone} title="Heads up">Body text</MessageBox>);
    const box = screen.getByRole("status");
    expect(box).toHaveClass("message-box", tone);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("sets the title apart from the body", () => {
    render(
      <MessageBox tone="warning" title="Storage is not set up">
        Uploads have nowhere to go yet.
      </MessageBox>
    );
    const box = screen.getByRole("status");
    const title = within(box).getByText("Storage is not set up");
    expect(title.tagName).toBe("STRONG");
    const body = within(box).getByText("Uploads have nowhere to go yet.");
    expect(body).toHaveClass("message-box-body");
    expect(title).not.toContainElement(body);
  });

  it("renders rich body content, not just a string", () => {
    render(
      <MessageBox tone="info" title="Scan finished">
        <p>12 books added.</p>
        <a href="/library">Open the library</a>
      </MessageBox>
    );
    expect(screen.getByRole("link", { name: "Open the library" })).toHaveAttribute("href", "/library");
    expect(screen.getByText("12 books added.")).toBeInTheDocument();
  });

  it("keeps its icon out of the accessibility tree", () => {
    const { container } = render(<MessageBox tone="success" title="Saved">Done.</MessageBox>);
    const icons = container.querySelectorAll("svg");
    expect(icons).toHaveLength(1);
    expect(icons[0]).toHaveAttribute("aria-hidden", "true");
    // The box reads as its words alone.
    expect(screen.getByRole("status")).toHaveTextContent(/^SavedDone\.$/);
  });

  it("draws a different icon for each tone", () => {
    const markup = (["info", "warning", "error", "success"] as const).map((tone) => {
      const { container, unmount } = render(<MessageBox tone={tone} title="t">b</MessageBox>);
      const svg = container.querySelector("svg")!.innerHTML;
      unmount();
      return svg;
    });
    expect(new Set(markup).size).toBe(4);
  });

  it("shows a call to action under the message when given one", async () => {
    const user = userEvent.setup();
    const onSetUp = vi.fn();
    render(
      <MessageBox
        tone="warning"
        title="Storage is not set up"
        action={<Button variant="primary" onClick={onSetUp}>Set up storage</Button>}
      >
        Uploads have nowhere to go yet.
      </MessageBox>
    );
    const action = screen.getByRole("button", { name: "Set up storage" });
    expect(action.parentElement).toHaveClass("message-box-action");
    await user.click(action);
    expect(onSetUp).toHaveBeenCalledTimes(1);
  });

  it("renders no action row without an action", () => {
    const { container } = render(<MessageBox tone="info" title="Nothing here">Empty.</MessageBox>);
    expect(container.querySelector(".message-box-action")).toBeNull();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("appends the caller's class after the tone", () => {
    render(<MessageBox tone="error" title="Unable to load" className="inline-error">Try again.</MessageBox>);
    expect(screen.getByRole("alert").className).toBe("message-box error inline-error");
  });
});
