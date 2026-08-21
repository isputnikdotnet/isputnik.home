import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Tooltip } from "../src/shared/Tooltip";

// The tooltip exists because a `title` on a glyph inside `.datagrid-wrap` is both
// slow and clippable. What has to hold: it opens on hover, it lands in <body>
// rather than inside whatever scrolling box the trigger sits in, it closes when
// the pointer leaves, and it never becomes the only place its text lives.

function rect(over: Partial<DOMRect>): DOMRect {
  const base = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  const merged = { ...base, ...over };
  return { ...merged, toJSON: () => merged } as DOMRect;
}

/** jsdom measures everything as zero; these stand in for a laid-out page. */
function stubLayout(triggerTop: number) {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.classList.contains("tooltip-bubble")) {
      return rect({ width: 80, height: 26 });
    }
    return rect({ top: triggerTop, bottom: triggerTop + 28, left: 500, right: 534, width: 34, height: 28 });
  });
}

afterEach(() => vi.restoreAllMocks());

describe("Tooltip", () => {
  it("opens on hover, in <body>, and closes when the pointer leaves", async () => {
    const user = userEvent.setup();
    stubLayout(300);
    render(
      <div style={{ overflow: "hidden" }}>
        <Tooltip label="Passkey">
          <span role="img" aria-label="Passkey">icon</span>
        </Tooltip>
      </div>
    );

    expect(screen.queryByText("Passkey", { selector: ".tooltip-bubble" })).toBeNull();

    await user.hover(screen.getByText("icon"));
    const bubble = await screen.findByText("Passkey", { selector: ".tooltip-bubble" });
    // Portalled out of the clipping ancestor, and hidden from assistive tech —
    // the trigger's own aria-label already says this.
    expect(bubble.parentElement).toBe(document.body);
    expect(bubble.getAttribute("aria-hidden")).toBe("true");

    await user.unhover(screen.getByText("icon"));
    await waitFor(() => expect(screen.queryByText("Passkey", { selector: ".tooltip-bubble" })).toBeNull());
  });

  it("sits above the trigger, and flips under it when there is no room", async () => {
    const user = userEvent.setup();
    stubLayout(300);
    const { unmount } = render(
      <Tooltip label="Password">
        <span role="img" aria-label="Password">icon</span>
      </Tooltip>
    );

    await user.hover(screen.getByText("icon"));
    const above = await screen.findByText("Password", { selector: ".tooltip-bubble" });
    // 300 (trigger top) − 26 (bubble) − 8 (gap): the second pass, once the bubble
    // has a measurable height.
    await waitFor(() => expect(above.style.top).toBe("266px"));
    expect(above.classList.contains("is-below")).toBe(false);
    unmount();

    stubLayout(6); // hard against the top of the window
    render(
      <Tooltip label="Password">
        <span role="img" aria-label="Password">icon</span>
      </Tooltip>
    );
    await user.hover(screen.getByText("icon"));
    const below = await screen.findByText("Password", { selector: ".tooltip-bubble" });
    await waitFor(() => expect(below.classList.contains("is-below")).toBe(true));
    expect(below.style.top).toBe("42px"); // 6 + 28 (trigger height) + 8 (gap)
  });

  it("closes on scroll rather than drifting away from its trigger", async () => {
    const user = userEvent.setup();
    stubLayout(300);
    render(
      <Tooltip label="Device link">
        <span role="img" aria-label="Device link">icon</span>
      </Tooltip>
    );

    await user.hover(screen.getByText("icon"));
    await screen.findByText("Device link", { selector: ".tooltip-bubble" });

    window.dispatchEvent(new Event("scroll"));
    await waitFor(() => expect(screen.queryByText("Device link", { selector: ".tooltip-bubble" })).toBeNull());
  });
});
