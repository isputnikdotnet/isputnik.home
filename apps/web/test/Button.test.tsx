import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "../src/shared/Button";

// Button is the single way the app renders a button, so its contract is what
// every Add / Cancel / Delete rests on: a variant always maps to exactly one of
// the button classes in styles/components.css, and a button is type="button"
// unless it says otherwise — a stray click inside a form must never submit it.
// The tab/tile/chip/bare variants carry no class of their own: the look is the
// caller's className, passed through untouched, so converting a raw <button> to
// one of them can't restyle it.

describe("Button", () => {
  it("defaults to the secondary variant and type=button", () => {
    render(<Button>Cancel</Button>);
    const button = screen.getByRole("button", { name: "Cancel" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveClass("secondary-button");
    expect(button.className).toBe("secondary-button");
  });

  it.each([
    ["primary", "primary-button"],
    ["secondary", "secondary-button"],
    ["danger", "danger-button"],
    ["text", "text-button"],
    ["icon", "icon-button"],
    ["toolbar", "library-toolbar-button"]
  ] as const)("maps the %s variant onto .%s and nothing else", (variant, cls) => {
    render(<Button variant={variant} aria-label="Act">Act</Button>);
    expect(screen.getByRole("button", { name: "Act" }).className).toBe(cls);
  });

  it("adds the danger and compact modifiers and keeps the caller's class last", () => {
    render(<Button variant="icon" danger compact className="accent-gold" aria-label="Remove">x</Button>);
    const button = screen.getByRole("button", { name: "Remove" });
    expect(button.className).toBe("icon-button danger compact-button accent-gold");
  });

  it("leaves the modifiers off unless asked", () => {
    render(<Button variant="text" danger={false} compact={false}>Details</Button>);
    const button = screen.getByRole("button", { name: "Details" });
    expect(button).not.toHaveClass("danger");
    expect(button).not.toHaveClass("compact-button");
  });

  it("does not submit a surrounding form by default", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    const onClick = vi.fn();
    render(
      <form onSubmit={onSubmit}>
        <Button onClick={onClick}>Add tag</Button>
      </form>
    );
    await user.click(screen.getByRole("button", { name: "Add tag" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits the form when it is explicitly a submit button", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Button variant="primary" type="submit">Save</Button>
      </form>
    );
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toHaveAttribute("type", "submit");
    await user.click(save);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("ignores clicks while disabled — the busy state of a running action", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button variant="primary" disabled onClick={onClick}>Saving…</Button>);
    const button = screen.getByRole("button", { name: "Saving…" });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("runs from the keyboard like any native button", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Close</Button>);
    await user.tab();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("takes its accessible name from aria-label for an icon-only button", () => {
    render(
      <Button variant="icon" aria-label="Delete photo" title="Delete photo">
        <svg aria-hidden="true" />
      </Button>
    );
    const button = screen.getByRole("button", { name: "Delete photo" });
    expect(button).toHaveAttribute("title", "Delete photo");
    expect(button).toHaveClass("icon-button");
  });

  it("falls back to title for the accessible name when there is no aria-label", () => {
    render(
      <Button variant="icon" title="Refresh">
        <svg aria-hidden="true" />
      </Button>
    );
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });

  it("gives the toolbar variant the toolbar's own primary and danger modifiers", () => {
    render(
      <>
        <Button variant="toolbar" className="primary">Upload</Button>
        <Button variant="toolbar" danger>Delete</Button>
      </>
    );
    expect(screen.getByRole("button", { name: "Upload" }).className).toBe("library-toolbar-button primary");
    expect(screen.getByRole("button", { name: "Delete" }).className).toBe("library-toolbar-button danger");
  });

  it.each(["tile", "chip", "bare"] as const)("adds no class of its own for the %s variant — the caller's class is the look", (variant) => {
    render(
      <>
        <Button variant={variant} className="gallery-folder-tile add-to-album-tile">Holiday</Button>
        <Button variant={variant}>Plain</Button>
      </>
    );
    expect(screen.getByRole("button", { name: "Holiday" }).className).toBe("gallery-folder-tile add-to-album-tile");
    // A button its row styles gets no class attribute at all, as it had before.
    const plain = screen.getByRole("button", { name: "Plain" });
    expect(plain).not.toHaveAttribute("class");
    expect(plain).toHaveAttribute("type", "button");
  });

  describe("tab", () => {
    function Row({ selected = "details" }: { selected?: string }) {
      return (
        <div role="tablist" aria-label="Sections">
          {["details", "tags", "cover"].map((key) => (
            <Button key={key} variant="tab" className="modal-tab" selected={selected === key} disabled={key === "tags" && selected === "cover"}>
              {key}
            </Button>
          ))}
        </div>
      );
    }

    it("is a tab, selected or not, with the rows' shared active class on the chosen one", () => {
      render(<Row />);
      const details = screen.getByRole("tab", { name: "details" });
      expect(details).toHaveAttribute("aria-selected", "true");
      expect(details.className).toBe("modal-tab active");
      const tags = screen.getByRole("tab", { name: "tags" });
      expect(tags).toHaveAttribute("aria-selected", "false");
      expect(tags.className).toBe("modal-tab");
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });

    it("leaves aria-selected to the caller when it marks the chosen tab with a class of its own", () => {
      render(
        <div role="tablist">
          <Button variant="tab" className="photo-picker-chip is-active" aria-selected>Anna</Button>
        </div>
      );
      const tab = screen.getByRole("tab", { name: "Anna", selected: true });
      expect(tab.className).toBe("photo-picker-chip is-active");
    });

    it("walks the row with Left/Right (wrapping) and Home/End, skipping disabled tabs, without choosing", async () => {
      const user = userEvent.setup();
      render(<Row selected="cover" />);
      const [details, , cover] = screen.getAllByRole("tab");
      cover.focus();
      await user.keyboard("{ArrowRight}");
      expect(details).toHaveFocus();
      // "tags" is disabled, so Right from details lands on cover.
      await user.keyboard("{ArrowRight}");
      expect(cover).toHaveFocus();
      await user.keyboard("{ArrowLeft}");
      expect(details).toHaveFocus();
      await user.keyboard("{End}");
      expect(cover).toHaveFocus();
      await user.keyboard("{Home}");
      expect(details).toHaveFocus();
      // Moving focus chose nothing.
      expect(screen.getByRole("tab", { name: "cover", selected: true })).toBeInTheDocument();
    });

    it("still runs the caller's own onKeyDown, and a handled key doesn't move focus", async () => {
      const user = userEvent.setup();
      const onKeyDown = vi.fn((event: React.KeyboardEvent) => event.preventDefault());
      render(
        <div role="tablist">
          <Button variant="tab" selected onKeyDown={onKeyDown}>One</Button>
          <Button variant="tab" selected={false}>Two</Button>
        </div>
      );
      screen.getByRole("tab", { name: "One" }).focus();
      await user.keyboard("{ArrowRight}");
      expect(onKeyDown).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("tab", { name: "One" })).toHaveFocus();
    });

    it("keeps selected and its class off every other variant", () => {
      render(<Button variant="secondary" selected>Plain</Button>);
      const button = screen.getByRole("button", { name: "Plain" });
      expect(button).not.toHaveAttribute("aria-selected");
      expect(button).not.toHaveAttribute("role");
      expect(button.className).toBe("secondary-button");
    });
  });

  it("passes other attributes through and forwards its ref to the <button>", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref} aria-pressed="true" data-testid="toggle">Select</Button>);
    const button = screen.getByRole("button", { name: "Select", pressed: true });
    expect(button).toHaveAttribute("data-testid", "toggle");
    expect(ref.current).toBe(button);
  });
});
