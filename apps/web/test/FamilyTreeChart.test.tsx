import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeChartLayout, NODE_H, NODE_W } from "../src/features/familytree/chart-layout";
import { FamilyTreeChart } from "../src/features/familytree/FamilyTreeChart";
import type { FamilyPerson, FamilyTree, FamilyUnion } from "../src/features/familytree/types";

// familyChartLayout.test.ts owns the geometry; this owns the MEASURING. The chart
// used to read svgRef.current.getBoundingClientRect() in the middle of a render to
// place the zoom readout and the card menu; it now observes its own box into state,
// and these tests are what says the two still follow the element.
//
// jsdom has no layout engine, so the box is whatever `frame` below says it is and
// the ResizeObserver is a fake that fires when the test tells it to — which is
// exactly the pair the component depends on.

const person = (id: string, over: Partial<FamilyPerson> = {}): FamilyPerson => ({
  id,
  name: id,
  maidenName: null,
  gender: "unknown",
  birthDate: null,
  deathDate: null,
  birthplace: null,
  deathPlace: null,
  bio: null,
  portraitUrl: null,
  portraitItemId: null,
  galleryPersonId: null,
  tags: [],
  canEdit: false,
  ...over
});

const union = (id: string, person1Id: string, person2Id: string): FamilyUnion => ({
  id,
  person1Id,
  person2Id,
  status: "married",
  marriedDate: null,
  marriedPlace: null,
  divorcedDate: null,
  note: null
});

// A wide tree on purpose: the content has to be broader than the frame, or the fit
// caps at 1:1 and the readout says 100% whatever the element measures.
const CHILD_IDS = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10", "c11", "c12"];
const tree: FamilyTree = {
  persons: [person("ma"), person("pa"), ...CHILD_IDS.map((id) => person(id))],
  unions: [union("u1", "ma", "pa")],
  children: CHILD_IDS.map((childId) => ({ unionId: "u1", childId, relation: "biological" as const })),
  access: { isAdmin: false, canAdd: false },
  defaultPersonId: null
};
const FOCUS = "ma";

// What the component would measure, and the handle the fake observer reports with.
let frame = { width: 1000, height: 700 };
let fireObservers: () => void = () => {};

beforeEach(() => {
  frame = { width: 1000, height: 700 };
  const callbacks: ResizeObserverCallback[] = [];
  class FakeResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe() {
      callbacks.push(this.callback);
      // The real one delivers the current size as soon as it starts observing;
      // without that first delivery nothing would ever be measured.
      this.callback([], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {
      const at = callbacks.indexOf(this.callback);
      if (at >= 0) callbacks.splice(at, 1);
    }
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  fireObservers = () => {
    const observer = new FakeResizeObserver(() => {}) as unknown as ResizeObserver;
    act(() => { for (const callback of [...callbacks]) callback([], observer); });
  };
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    // Only the width and height are read from the chart; left/top are 0 in jsdom
    // anyway and only matter for cursor-anchored zoom, which these tests don't do.
    return { width: frame.width, height: frame.height, x: 0, y: 0, top: 0, left: 0, right: frame.width, bottom: frame.height, toJSON: () => ({}) } as DOMRect;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderChart() {
  const onOpenProfile = vi.fn();
  render(
    <FamilyTreeChart
      tree={tree}
      focusId={FOCUS}
      onFocus={vi.fn()}
      onOpenProfile={onOpenProfile}
      onEditPerson={vi.fn()}
      onAddRelative={vi.fn()}
      onHome={vi.fn()}
    />
  );
  return { onOpenProfile };
}

const zoomPercent = () => {
  const text = document.querySelector(".ft-chart-zoom-value")?.textContent ?? "";
  return Number.parseInt(text, 10);
};
const cardMenu = () => document.querySelector<HTMLElement>(".ft-chart-card-menu");

// The fit the chart performs on mount, worked out from the same two numbers the
// component has: the layout's extent and the measured frame.
function fittedPercent(width: number, height: number): number {
  const { minX, minY, maxX, maxY } = computeChartLayout(tree, FOCUS).bounds;
  const scale = Math.min(width / (maxX - minX), height / (maxY - minY), 1);
  return Math.round(scale * 100);
}

describe("FamilyTreeChart measuring", () => {
  it("shows the zoom the fit arrived at once the element has been measured", () => {
    renderChart();
    const expected = fittedPercent(1000, 700);
    // The tree is wider than the frame, so this is a real reduction — otherwise the
    // test would pass on a component that had stopped measuring at all.
    expect(expected).toBeLessThan(100);
    expect(zoomPercent()).toBe(expected);
    expect(screen.getByLabelText(`Current zoom ${expected}%`)).toBeInTheDocument();
  });

  it("follows the element when it is resized", () => {
    renderChart();
    const before = zoomPercent();
    // The viewBox is untouched by a resize (only `layout` re-fits), so twice the
    // element at the same viewBox is twice the zoom.
    frame = { width: 2000, height: 1400 };
    fireObservers();
    expect(zoomPercent()).toBe(before * 2);
  });

  it("opens the card menu inside the frame it measured", async () => {
    renderChart();
    await userEvent.click(screen.getByLabelText("Actions for ma"));
    const menu = cardMenu();
    expect(menu).not.toBeNull();
    const left = Number.parseFloat(menu!.style.left);
    const top = Number.parseFloat(menu!.style.top);
    // 208×176 is the menu's own size; the placement keeps it 8px clear of every edge.
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left).toBeLessThanOrEqual(1000 - 208 - 8);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(top).toBeLessThanOrEqual(700 - 176 - 8);
  });

  it("keeps the card menu glued to its badge across a resize", async () => {
    renderChart();
    await userEvent.click(screen.getByLabelText("Actions for ma"));
    const before = cardMenu()!;
    const left = Number.parseFloat(before.style.left);
    const top = Number.parseFloat(before.style.top);

    frame = { width: 2000, height: 1400 };
    fireObservers();

    const after = cardMenu()!;
    // Same viewBox, twice the element: every user-space point lands twice as far
    // from the frame's origin. The +14 is the nudge off the badge, applied after
    // the mapping, so it comes out of the doubling and goes back on.
    expect(Number.parseFloat(after.style.left)).toBeCloseTo((left - 14) * 2 + 14, 5);
    expect(Number.parseFloat(after.style.top)).toBeCloseTo((top - 14) * 2 + 14, 5);
  });

  it("puts the menu where the badge is, not where the card is", async () => {
    renderChart();
    await userEvent.click(screen.getByLabelText("Actions for ma"));
    const menu = cardMenu()!;

    const layout = computeChartLayout(tree, FOCUS);
    const { minX, minY, maxX, maxY } = layout.bounds;
    const node = layout.nodes.find((n) => n.person.id === "ma")!;
    // The viewBox after the mount fit, then the "xMidYMid meet" mapping the SVG
    // applies to it — the same two steps the card menu has to mirror.
    const fit = Math.min(1000 / (maxX - minX), 700 / (maxY - minY), 1);
    const box = {
      x: minX + (maxX - minX) / 2 - (1000 / fit) / 2,
      y: minY + (maxY - minY) / 2 - (700 / fit) / 2,
      w: 1000 / fit,
      h: 700 / fit
    };
    const scale = Math.min(1000 / box.w, 700 / box.h);
    const badgeX = node.x + NODE_W / 2 - 15;
    const badgeY = node.y - NODE_H / 2 + 15;
    const expectedLeft = (1000 - box.w * scale) / 2 + (badgeX - box.x) * scale + 14;
    const expectedTop = (700 - box.h * scale) / 2 + (badgeY - box.y) * scale + 14;

    expect(Number.parseFloat(menu.style.left)).toBeCloseTo(expectedLeft, 4);
    expect(Number.parseFloat(menu.style.top)).toBeCloseTo(expectedTop, 4);
  });
});
