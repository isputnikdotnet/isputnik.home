import { describe, expect, it } from "vitest";
import {
  computeChartLayout,
  defaultFocusId,
  isEndedUnion,
  NODE_H,
  NODE_W,
  type ChartLayout,
  type PlacedNode
} from "../src/features/familytree/chart-layout";
import type { FamilyPerson, FamilyTree, FamilyUnion } from "../src/features/familytree/types";

// The chart is pure geometry, so these check what a reader of the chart relies on
// rather than pixel values: who lands on which generation row, who sits beside
// whom, that no two cards overlap, that every line starts and ends on a card, and
// that the bounds hold everything. The few exact numbers asserted are the ones
// that follow from the exported card size alone.

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

const union = (
  id: string,
  person1Id: string,
  person2Id: string | null,
  status: FamilyUnion["status"] = "married"
): FamilyUnion => ({
  id,
  person1Id,
  person2Id,
  status,
  marriedDate: null,
  marriedPlace: null,
  divorcedDate: null,
  note: null
});

function tree(
  persons: (string | FamilyPerson)[],
  unions: FamilyUnion[] = [],
  children: [unionId: string, childId: string][] = []
): FamilyTree {
  return {
    persons: persons.map((p) => (typeof p === "string" ? person(p) : p)),
    unions,
    children: children.map(([unionId, childId]) => ({ unionId, childId, relation: "biological" })),
    access: { isAdmin: false, canAdd: false },
    defaultPersonId: null
  };
}

const node = (layout: ChartLayout, id: string): PlacedNode => {
  const found = layout.nodes.find((n) => n.person.id === id);
  if (!found) throw new Error(`${id} was not placed`);
  return found;
};
const placedIds = (layout: ChartLayout) => layout.nodes.map((n) => n.person.id).sort();
const rowOf = (layout: ChartLayout, gen: number) =>
  layout.nodes.filter((n) => n.gen === gen).sort((a, b) => a.x - b.x).map((n) => n.person.id);

// ── Invariants every layout must satisfy ──

function expectEveryoneOnce(layout: ChartLayout) {
  const ids = layout.nodes.map((n) => n.person.id);
  expect(new Set(ids).size).toBe(ids.length);
}

// Rows are horizontal bands: one y per generation, oldest at the top, and far
// enough apart that cards in neighbouring rows never touch.
function expectRowsStacked(layout: ChartLayout) {
  const yByGen = new Map<number, number>();
  for (const n of layout.nodes) {
    expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true);
    if (yByGen.has(n.gen)) expect(n.y).toBe(yByGen.get(n.gen));
    else yByGen.set(n.gen, n.y);
  }
  const gens = [...yByGen.keys()].sort((a, b) => a - b);
  for (let i = 1; i < gens.length; i++) {
    const pitch = (yByGen.get(gens[i])! - yByGen.get(gens[i - 1])!) / (gens[i] - gens[i - 1]);
    expect(pitch).toBeGreaterThan(NODE_H);
  }
  if (yByGen.has(0)) expect(yByGen.get(0)).toBe(0);
}

// No two cards in a row overlap — there is always clear space between them.
function expectNoOverlaps(layout: ChartLayout) {
  const rows = new Map<number, PlacedNode[]>();
  for (const n of layout.nodes) rows.set(n.gen, [...(rows.get(n.gen) ?? []), n]);
  for (const [gen, row] of rows) {
    const xs = row.map((n) => n.x).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) {
      const gap = xs[i] - xs[i - 1];
      if (gap <= NODE_W) {
        throw new Error(`cards overlap on row ${gen}: centers ${xs[i - 1]} and ${xs[i]} (card width ${NODE_W})`);
      }
    }
  }
}

function expectInsideBounds(layout: ChartLayout) {
  const { minX, minY, maxX, maxY } = layout.bounds;
  for (const n of layout.nodes) {
    expect(n.x - NODE_W / 2).toBeGreaterThan(minX);
    expect(n.x + NODE_W / 2).toBeLessThan(maxX);
    expect(n.y - NODE_H / 2).toBeGreaterThan(minY);
    expect(n.y + NODE_H / 2).toBeLessThan(maxY);
  }
  for (const d of layout.dots) {
    expect(d.x).toBeGreaterThan(minX);
    expect(d.x).toBeLessThan(maxX);
    expect(d.y).toBeGreaterThan(minY);
    expect(d.y).toBeLessThan(maxY);
  }
}

type Segment = { x: number; y: number; axis: "H" | "V"; to: number; ended?: boolean };
const segments = (layout: ChartLayout): Segment[] =>
  layout.edgePaths.map((edge) => {
    const match = /^M (-?[\d.]+) (-?[\d.]+) ([HV]) (-?[\d.]+)$/.exec(edge.d);
    if (!match) throw new Error(`unexpected path shape: ${edge.d}`);
    return { x: Number(match[1]), y: Number(match[2]), axis: match[3] as "H" | "V", to: Number(match[4]), ended: edge.ended };
  });

// Edges are drawn from final positions, so they can never detach: a line into a
// child ends on the top edge of a placed card, and a spouse line runs from one
// card's right edge to the next card's left edge on the same row.
function expectEdgesAttached(layout: ChartLayout) {
  const cards = layout.nodes;
  const busRows = new Set<number>();
  for (const s of segments(layout)) {
    expect(Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.to)).toBe(true);
    const onCardRow = cards.some((c) => c.y === s.y);
    const fromDot = layout.dots.some((d) => d.x === s.x && d.y === s.y);
    if (s.axis === "H" && onCardRow) {
      // A spouse line: from one card's right edge to another's left edge.
      expect(cards.some((c) => c.y === s.y && c.x + NODE_W / 2 === s.x)).toBe(true);
      expect(cards.some((c) => c.y === s.y && c.x - NODE_W / 2 === s.to)).toBe(true);
      expect(s.x).toBeLessThan(s.to);
    } else if (s.axis === "V" && fromDot) {
      // A descent from a badge, down to the bus.
      expect(s.to).toBeGreaterThan(s.y);
      busRows.add(s.to);
    } else if (s.axis === "V" && cards.some((c) => c.x === s.x && c.y + NODE_H / 2 === s.y)) {
      // A bracket leg (a third or later partner): down from a card's bottom edge
      // to the bracket that runs under the row.
      expect(s.to).toBeGreaterThan(s.y);
    } else if (s.axis === "V") {
      // A drop from the bus onto a child: it ends exactly on a card's top edge.
      expect(cards.some((c) => c.x === s.x && c.y - NODE_H / 2 === s.to)).toBe(true);
      expect(s.y).toBeLessThan(s.to);
    }
  }
  // Every bus a badge descends to is actually drawn.
  const buses = segments(layout).filter((s) => s.axis === "H" && !cards.some((c) => c.y === s.y));
  for (const y of busRows) expect(buses.some((b) => b.y === y)).toBe(true);
}

function expectSound(layout: ChartLayout) {
  expectEveryoneOnce(layout);
  expectRowsStacked(layout);
  expectNoOverlaps(layout);
  expectInsideBounds(layout);
  expectEdgesAttached(layout);
}

describe("isEndedUnion", () => {
  it("treats divorced and widowed as past, everything else as current", () => {
    expect(isEndedUnion("divorced")).toBe(true);
    expect(isEndedUnion("widowed")).toBe(true);
    expect(isEndedUnion("married")).toBe(false);
    expect(isEndedUnion("partners")).toBe(false);
    expect(isEndedUnion("unknown")).toBe(false);
  });
});

describe("defaultFocusId", () => {
  it("is null for an empty tree", () => {
    expect(defaultFocusId(tree([]))).toBeNull();
  });

  it("prefers someone in a union, since that is where a tree has shape", () => {
    expect(defaultFocusId(tree(["loner", "a", "b"], [union("u1", "a", "b")]))).toBe("a");
  });

  it("falls back to the first person when nobody is in a union", () => {
    expect(defaultFocusId(tree(["first", "second"]))).toBe("first");
  });
});

describe("computeChartLayout — degenerate trees", () => {
  it("returns an empty layout with zero bounds for an empty tree", () => {
    const layout = computeChartLayout(tree([]), "anyone");
    expect(layout).toEqual({ nodes: [], dots: [], edgePaths: [], bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } });
  });

  it("draws one person alone at the origin, padded all round", () => {
    const layout = computeChartLayout(tree(["solo"]), "solo");
    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0]).toMatchObject({ x: 0, y: 0, gen: 0, isFocus: true });
    expect(layout.dots).toEqual([]);
    expect(layout.edgePaths).toEqual([]);
    // Symmetric about the card, with the same padding on every side.
    const { minX, minY, maxX, maxY } = layout.bounds;
    expect(minX).toBe(-maxX);
    expect(minY).toBe(-maxY);
    expect(maxX - NODE_W / 2).toBe(maxY - NODE_H / 2);
    expect(maxX - NODE_W / 2).toBeGreaterThan(0);
  });

  it("falls back to the default focus when the requested person is not in the tree", () => {
    const layout = computeChartLayout(tree(["loner", "a", "b"], [union("u1", "a", "b")]), "deleted-person");
    const focus = layout.nodes.filter((n) => n.isFocus);
    expect(focus.map((n) => n.person.id)).toEqual(["a"]);
    expect(focus[0]).toMatchObject({ gen: 0, y: 0 });
  });

  it("leaves unconnected people off the chart", () => {
    const layout = computeChartLayout(tree(["a", "b", "stranger"], [union("u1", "a", "b")]), "a");
    expect(placedIds(layout)).toEqual(["a", "b"]);
  });

  it("marks exactly one card as the focus", () => {
    const layout = computeChartLayout(
      tree(["a", "b", "kid"], [union("u1", "a", "b")], [["u1", "kid"]]),
      "kid"
    );
    expect(layout.nodes.filter((n) => n.isFocus).map((n) => n.person.id)).toEqual(["kid"]);
  });
});

describe("computeChartLayout — couples", () => {
  it("puts spouses side by side with the union badge centred in the gap between them", () => {
    const layout = computeChartLayout(tree(["me", "wife"], [union("u1", "me", "wife")]), "me");
    expectSound(layout);
    const me = node(layout, "me");
    const wife = node(layout, "wife");
    expect(me.gen).toBe(0);
    expect(wife.gen).toBe(0);
    // The focus person reads first; the couple is centred on the origin.
    expect(me.x).toBeLessThan(wife.x);
    expect(me.x + wife.x).toBe(0);

    expect(layout.dots).toEqual([{ unionId: "u1", x: 0, y: 0, status: "married" }]);
    // The spouse line bridges card edge to card edge, and is solid while current.
    expect(layout.edgePaths).toEqual([{ d: `M ${me.x + NODE_W / 2} 0 H ${wife.x - NODE_W / 2}`, ended: false }]);
  });

  it("keeps the focus person first even when they are the second partner on record", () => {
    const layout = computeChartLayout(tree(["husband", "me"], [union("u1", "husband", "me")]), "me");
    expect(rowOf(layout, 0)).toEqual(["me", "husband"]);
  });

  it("draws an ended union's spouse line dashed and says so on the badge", () => {
    for (const status of ["divorced", "widowed"] as const) {
      const layout = computeChartLayout(tree(["me", "ex"], [union("u1", "me", "ex", status)]), "me");
      expect(layout.edgePaths).toHaveLength(1);
      expect(layout.edgePaths[0].ended).toBe(true);
      expect(layout.dots[0].status).toBe(status);
    }
  });

  it("places two partners either side of the person, each badge between that person and that partner", () => {
    const layout = computeChartLayout(
      tree(["me", "first", "second"], [union("u1", "me", "first", "divorced"), union("u2", "me", "second")]),
      "me"
    );
    expectSound(layout);
    expect(rowOf(layout, 0)).toEqual(["first", "me", "second"]);

    const me = node(layout, "me");
    const dot1 = layout.dots.find((d) => d.unionId === "u1")!;
    const dot2 = layout.dots.find((d) => d.unionId === "u2")!;
    expect(dot1.x).toBe((node(layout, "first").x + me.x) / 2);
    expect(dot2.x).toBe((node(layout, "second").x + me.x) / 2);
    expect(dot1.status).toBe("divorced");
    expect(dot2.status).toBe("married");
    // Only the ended union's line is dashed.
    const spouseLines = segments(layout).filter((s) => s.axis === "H" && s.y === me.y);
    expect(spouseLines).toHaveLength(2);
    expect(spouseLines.find((s) => s.to <= me.x)?.ended).toBe(true);
    expect(spouseLines.find((s) => s.x >= me.x)?.ended).toBe(false);
  });

  it("keeps a third partner's badge and line off the second partner's card", () => {
    const layout = computeChartLayout(
      tree(["me", "first", "second", "third"], [
        union("u1", "me", "first", "divorced"),
        union("u2", "me", "second", "divorced"),
        union("u3", "me", "third")
      ]),
      "me"
    );
    expectSound(layout);
    expect(rowOf(layout, 0)).toEqual(["first", "me", "second", "third"]);
    const onACard = (x: number, y: number) =>
      layout.nodes.some((n) => Math.abs(n.x - x) < NODE_W / 2 && Math.abs(n.y - y) < NODE_H / 2);
    for (const dot of layout.dots) expect(onACard(dot.x, dot.y)).toBe(false);
    // The third union's badge sits under its own partner, below the row.
    const third = node(layout, "third");
    const dot3 = layout.dots.find((d) => d.unionId === "u3")!;
    expect(dot3.x).toBe(third.x);
    expect(dot3.y).toBeGreaterThan(third.y + NODE_H / 2);
  });

  it("ignores a partner id that points at nobody in the tree", () => {
    const layout = computeChartLayout(tree(["me"], [union("u1", "me", "ghost")]), "me");
    expect(placedIds(layout)).toEqual(["me"]);
    expect(layout.nodes[0].x).toBe(0);
    // A lone partner with no children has nothing for a badge to join.
    expect(layout.dots).toEqual([]);
    expect(layout.edgePaths).toEqual([]);
  });
});

describe("computeChartLayout — descendants", () => {
  const family = () =>
    tree(
      [
        "me",
        "wife",
        person("middle", { birthDate: "1990-05-01" }),
        person("eldest", { birthDate: "1985" }),
        person("undated")
      ],
      [union("u1", "me", "wife")],
      [["u1", "middle"], ["u1", "undated"], ["u1", "eldest"]]
    );

  it("hangs children one row below, oldest first, with unknown dates last", () => {
    const layout = computeChartLayout(family(), "me");
    expectSound(layout);
    expect(rowOf(layout, 0)).toEqual(["me", "wife"]);
    expect(rowOf(layout, 1)).toEqual(["eldest", "middle", "undated"]);
    expect(node(layout, "eldest").y).toBeGreaterThan(node(layout, "me").y);
  });

  it("centres the couple over their children", () => {
    const layout = computeChartLayout(family(), "me");
    const kids = ["eldest", "middle", "undated"].map((id) => node(layout, id).x);
    const dot = layout.dots[0];
    expect(dot.x).toBe((Math.min(...kids) + Math.max(...kids)) / 2);
  });

  it("drops one line from the badge to a bus, and one from the bus onto each child's card", () => {
    const layout = computeChartLayout(family(), "me");
    const dot = layout.dots[0];
    const segs = segments(layout);
    const kids = ["eldest", "middle", "undated"].map((id) => node(layout, id));

    const descent = segs.filter((s) => s.axis === "V" && s.x === dot.x && s.y === dot.y);
    expect(descent).toHaveLength(1);
    const busY = descent[0].to;
    // The bus runs between the rows — below the parents' cards, above the children's.
    expect(busY).toBeGreaterThan(dot.y + NODE_H / 2);
    expect(busY).toBeLessThan(kids[0].y - NODE_H / 2);

    const bus = segs.filter((s) => s.axis === "H" && s.y === busY);
    expect(bus).toHaveLength(1);
    expect(bus[0].x).toBe(Math.min(...kids.map((k) => k.x), dot.x));
    expect(bus[0].to).toBe(Math.max(...kids.map((k) => k.x), dot.x));

    for (const kid of kids) {
      expect(segs).toContainEqual({ x: kid.x, y: busY, axis: "V", to: kid.y - NODE_H / 2, ended: undefined });
    }
    // Descent lines are solid whatever became of the union.
    expect(layout.edgePaths.filter((e) => e.d.includes(" V ")).every((e) => e.ended === undefined)).toBe(true);
  });

  it("keeps descent lines solid under a divorced couple", () => {
    const layout = computeChartLayout(
      tree(["me", "ex", "kid"], [union("u1", "me", "ex", "divorced")], [["u1", "kid"]]),
      "me"
    );
    const segs = segments(layout);
    // The spouse line is the only dashed one; badge descent, bus and drop are solid.
    expect(segs.filter((s) => s.ended)).toEqual([expect.objectContaining({ axis: "H", y: 0 })]);
    expect(segs.filter((s) => s.axis === "V")).toHaveLength(2);
    expect(segs.filter((s) => s.axis === "V").every((s) => s.ended === undefined)).toBe(true);
  });

  it("gives a single parent's union a badge under their card, with the children still joined to it", () => {
    const layout = computeChartLayout(tree(["mum", "kid"], [union("u1", "mum", null)], [["u1", "kid"]]), "mum");
    expectSound(layout);
    const mum = node(layout, "mum");
    expect(layout.dots).toHaveLength(1);
    const dot = layout.dots[0];
    expect(dot.x).toBe(mum.x);
    // Below the card, not on top of it…
    expect(dot.y).toBeGreaterThan(mum.y + NODE_H / 2);
    // …and above the child row, with a line down to the child.
    const kid = node(layout, "kid");
    expect(dot.y).toBeLessThan(kid.y - NODE_H / 2);
    expect(segments(layout).some((s) => s.axis === "V" && s.x === kid.x && s.to === kid.y - NODE_H / 2)).toBe(true);
  });

  it("expands the focus person's line all the way down", () => {
    const layout = computeChartLayout(
      tree(
        ["me", "kid", "grandkid", "greatgrandkid"],
        [union("u1", "me", null), union("u2", "kid", null), union("u3", "grandkid", null)],
        [["u1", "kid"], ["u2", "grandkid"], ["u3", "greatgrandkid"]]
      ),
      "me"
    );
    expectSound(layout);
    expect(node(layout, "greatgrandkid").gen).toBe(3);
  });

  it("gives a wide child subtree its own room so cousins never overlap", () => {
    // Two children, each with a spouse and three kids of their own: the
    // grandchildren row is wider than the children row and must still not collide.
    const kids = (parent: string) => [1, 2, 3].map((n) => `${parent}-kid${n}`);
    const layout = computeChartLayout(
      tree(
        ["me", "wife", "a", "a-spouse", "b", "b-spouse", ...kids("a"), ...kids("b")],
        [union("u1", "me", "wife"), union("ua", "a", "a-spouse"), union("ub", "b", "b-spouse")],
        [["u1", "a"], ["u1", "b"], ...kids("a").map((k) => ["ua", k] as [string, string]), ...kids("b").map((k) => ["ub", k] as [string, string])]
      ),
      "me"
    );
    expectSound(layout);
    // Each family's children sit together, a's to the left of b's.
    const row2 = rowOf(layout, 2);
    expect(row2).toEqual([...kids("a"), ...kids("b")]);
    // And each couple is centred over its own children.
    for (const parent of ["a", "b"]) {
      const dot = layout.dots.find((d) => d.unionId === `u${parent}`)!;
      const xs = kids(parent).map((id) => node(layout, id).x);
      expect(dot.x).toBe((Math.min(...xs) + Math.max(...xs)) / 2);
    }
  });
});

describe("computeChartLayout — ancestors", () => {
  it("centres the parents as an adjacent couple over the focus person, one row up", () => {
    const layout = computeChartLayout(tree(["dad", "mum", "me"], [union("u0", "dad", "mum")], [["u0", "me"]]), "me");
    expectSound(layout);
    const me = node(layout, "me");
    const dad = node(layout, "dad");
    const mum = node(layout, "mum");
    expect(dad.gen).toBe(-1);
    expect(mum.gen).toBe(-1);
    expect(dad.y).toBeLessThan(me.y);
    expect(rowOf(layout, -1)).toEqual(["dad", "mum"]);
    expect((dad.x + mum.x) / 2).toBe(me.x);
    // The badge sits between them, with a line down to the child.
    const dot = layout.dots.find((d) => d.unionId === "u0")!;
    expect(dot.x).toBe(me.x);
    expect(segments(layout)).toContainEqual(
      expect.objectContaining({ axis: "V", x: me.x, to: me.y - NODE_H / 2 })
    );
  });

  it("lays grandparents out pedigree-style, each couple over the parent they belong to", () => {
    const layout = computeChartLayout(
      tree(
        ["gf1", "gm1", "gf2", "gm2", "dad", "mum", "me"],
        [union("ug1", "gf1", "gm1"), union("ug2", "gf2", "gm2"), union("u0", "dad", "mum")],
        [["ug1", "dad"], ["ug2", "mum"], ["u0", "me"]]
      ),
      "me"
    );
    expectSound(layout);
    expect(rowOf(layout, -2)).toEqual(["gf1", "gm1", "gf2", "gm2"]);
    expect(rowOf(layout, -1)).toEqual(["dad", "mum"]);
    // Dad's parents are on dad's side of the chart, mum's on mum's.
    const mid = node(layout, "me").x;
    expect(node(layout, "gm1").x).toBeLessThan(mid);
    expect(node(layout, "gf2").x).toBeGreaterThan(mid);
    // Each grandparent couple's badge connects down to its own child.
    for (const [unionId, child] of [["ug1", "dad"], ["ug2", "mum"]] as const) {
      const dot = layout.dots.find((d) => d.unionId === unionId)!;
      const c = node(layout, child);
      const segs = segments(layout);
      const descent = segs.find((s) => s.axis === "V" && s.x === dot.x && s.y === dot.y)!;
      expect(descent).toBeDefined();
      expect(segs).toContainEqual(expect.objectContaining({ axis: "V", x: c.x, y: descent.to, to: c.y - NODE_H / 2 }));
    }
  });

  it("draws a single recorded parent above the child with no gap in the line", () => {
    const layout = computeChartLayout(tree(["mum", "me"], [union("u0", "mum", null)], [["u0", "me"]]), "me");
    expectSound(layout);
    const mum = node(layout, "mum");
    expect(mum.gen).toBe(-1);
    expect(mum.x).toBe(node(layout, "me").x);
    expect(layout.dots).toHaveLength(1);
  });

  it("does not invent anyone for a missing parent", () => {
    const layout = computeChartLayout(
      tree(["mum", "me"], [union("u0", "mum", "not-in-tree")], [["u0", "me"]]),
      "me"
    );
    expect(placedIds(layout)).toEqual(["me", "mum"]);
  });
});

describe("computeChartLayout — collateral relatives", () => {
  // me + wife, parents dad (left) + mum (right), my siblings (older and younger),
  // an aunt on each side, a nephew through my sister, a cousin through each aunt,
  // and one generation below each of those that must stay collapsed.
  const bigTree = () =>
    tree(
      [
        person("me", { birthDate: "1975" }), "wife", "son", "grandson",
        "dad", "mum",
        person("older-sister", { birthDate: "1970" }),
        person("younger-brother", { birthDate: "1980" }),
        "sister-husband", "nephew", "grand-nephew",
        "dad-sister", "mum-brother", "dad-cousin", "mum-cousin", "cousin-kid",
        "gpa-d", "gma-d", "gpa-m", "gma-m"
      ],
      [
        union("u-me", "me", "wife"),
        union("u-son", "son", null),
        union("u-par", "dad", "mum"),
        union("u-sis", "older-sister", "sister-husband"),
        union("u-nephew", "nephew", null),
        union("u-gd", "gpa-d", "gma-d"),
        union("u-gm", "gpa-m", "gma-m"),
        union("u-ds", "dad-sister", null),
        union("u-mb", "mum-brother", null),
        union("u-dc", "dad-cousin", null)
      ],
      [
        ["u-me", "son"], ["u-son", "grandson"],
        ["u-par", "older-sister"], ["u-par", "me"], ["u-par", "younger-brother"],
        ["u-sis", "nephew"], ["u-nephew", "grand-nephew"],
        ["u-gd", "dad"], ["u-gd", "dad-sister"],
        ["u-gm", "mum"], ["u-gm", "mum-brother"],
        ["u-ds", "dad-cousin"], ["u-mb", "mum-cousin"], ["u-dc", "cousin-kid"]
      ]
    );

  it("produces a sound layout for a whole extended family", () => {
    expectSound(computeChartLayout(bigTree(), "me"));
  });

  it("puts siblings on the focus person's row, away from the spouse, still oldest to youngest", () => {
    const layout = computeChartLayout(bigTree(), "me");
    const me = node(layout, "me");
    const wife = node(layout, "wife");
    expect(wife.x).toBeGreaterThan(me.x);
    for (const sib of ["older-sister", "younger-brother"]) {
      expect(node(layout, sib).gen).toBe(0);
      expect(node(layout, sib).x).toBeLessThan(me.x);
    }
    expect(node(layout, "older-sister").x).toBeLessThan(node(layout, "younger-brother").x);
  });

  it("puts aunts and uncles beside their own sibling: dad's side left, mum's side right", () => {
    const layout = computeChartLayout(bigTree(), "me");
    const dad = node(layout, "dad");
    const mum = node(layout, "mum");
    expect(node(layout, "dad-sister")).toMatchObject({ gen: -1 });
    expect(node(layout, "mum-brother")).toMatchObject({ gen: -1 });
    expect(node(layout, "dad-sister").x).toBeLessThan(dad.x);
    expect(node(layout, "mum-brother").x).toBeGreaterThan(mum.x);
  });

  it("lands cousins on the focus row and nieces/nephews on the children's row", () => {
    const layout = computeChartLayout(bigTree(), "me");
    expect(node(layout, "dad-cousin").gen).toBe(0);
    expect(node(layout, "mum-cousin").gen).toBe(0);
    expect(node(layout, "nephew").gen).toBe(1);
    expect(node(layout, "son").gen).toBe(1);
  });

  it("expands collateral branches one generation only, while the direct line goes all the way", () => {
    const layout = computeChartLayout(bigTree(), "me");
    const ids = placedIds(layout);
    expect(ids).toContain("grandson");
    expect(ids).not.toContain("grand-nephew");
    expect(ids).not.toContain("cousin-kid");
  });

  it("re-centres on whoever is the focus", () => {
    const layout = computeChartLayout(bigTree(), "older-sister");
    expectSound(layout);
    expect(node(layout, "older-sister")).toMatchObject({ gen: 0, isFocus: true });
    expect(node(layout, "dad").gen).toBe(-1);
    // From her point of view, "me" is the collateral sibling, and my son her nephew.
    expect(node(layout, "me").gen).toBe(0);
    expect(node(layout, "son").gen).toBe(1);
    expect(placedIds(layout)).not.toContain("grandson");
    // Her own grandchild through the nephew is on the direct line now.
    expect(node(layout, "grand-nephew").gen).toBe(2);
  });
});

describe("computeChartLayout — awkward data", () => {
  it("places someone reachable by two routes only once (cousins who married)", () => {
    // Dad and mum are first cousins: gma-d and gpa-m are siblings.
    const layout = computeChartLayout(
      tree(
        ["top1", "top2", "gpa-d", "gma-d", "gpa-m", "gma-m", "dad", "mum", "me"],
        [
          union("u-top", "top1", "top2"),
          union("u-gd", "gpa-d", "gma-d"),
          union("u-gm", "gpa-m", "gma-m"),
          union("u-par", "dad", "mum")
        ],
        [["u-top", "gma-d"], ["u-top", "gpa-m"], ["u-gd", "dad"], ["u-gm", "mum"], ["u-par", "me"]]
      ),
      "me"
    );
    expectSound(layout);
    expect(node(layout, "top1").gen).toBe(-3);
    expect(node(layout, "gma-d").gen).toBe(-2);
    expect(node(layout, "gpa-m").gen).toBe(-2);
  });

  it("survives someone recorded as a child of their own union", () => {
    const layout = computeChartLayout(tree(["a", "b"], [union("u1", "a", "b")], [["u1", "a"]]), "a");
    expectSound(layout);
    expect(placedIds(layout)).toEqual(["a", "b"]);
  });

  it("survives a loop through the generations (someone their own grandparent)", () => {
    // a + b → c, c + d → a.
    const data = tree(
      ["a", "b", "c", "d"],
      [union("u1", "a", "b"), union("u2", "c", "d")],
      [["u1", "c"], ["u2", "a"]]
    );
    for (const focus of ["a", "b", "c", "d"]) {
      const layout = computeChartLayout(data, focus);
      expectEveryoneOnce(layout);
      expectRowsStacked(layout);
      expectNoOverlaps(layout);
      expectInsideBounds(layout);
      expect(node(layout, focus).isFocus).toBe(true);
    }
  });

  it("keeps the first parent union when a child is linked to two", () => {
    const layout = computeChartLayout(
      tree(
        ["dad", "mum", "step-dad", "step-mum", "me"],
        [union("u-real", "dad", "mum"), union("u-other", "step-dad", "step-mum")],
        [["u-real", "me"], ["u-other", "me"]]
      ),
      "me"
    );
    expectEveryoneOnce(layout);
    expectNoOverlaps(layout);
    expect(rowOf(layout, -1)).toEqual(["dad", "mum"]);
  });

  it("produces no NaN anywhere for a union with no partners placed", () => {
    const layout = computeChartLayout(
      tree(["me"], [union("u-empty", "nobody", "noone")], [["u-empty", "me"]]),
      "me"
    );
    expect(placedIds(layout)).toEqual(["me"]);
    expect(layout.dots).toEqual([]);
    for (const v of Object.values(layout.bounds)) expect(Number.isFinite(v)).toBe(true);
  });
});
