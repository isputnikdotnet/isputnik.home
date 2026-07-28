// Person-centered chart layout: pure geometry, no React. Generations flow
// TOP → BOTTOM (ancestors above, descendants below) and each generation is a
// row in which cards sit side by side — spouses adjacent with the union badge
// between them. Given the whole tree and a focus person, produces positioned
// cards, union badges, and edge paths:
//
//   • the focus person with their spouses side by side, descendants laid out
//     below (classic recursive subtree extents, parents centered above their
//     children);
//   • ancestors above in pedigree style (each parent couple centered over the
//     slot its own ancestors need);
//   • collateral relatives — the focus person's siblings, aunts/uncles with
//     their spouses, and cousins — on their own generation row beside the
//     direct line (each collateral subtree expands one generation of children
//     and no further, to bound the width).
//
// Internally the math packs along one scalar axis ("extent" = screen X) per
// generation; positions are computed first, then a per-row sweep resolves any
// overlap between the independently-anchored passes, and edges are drawn last
// from the final positions — so edges can never detach.
import type { FamilyPerson, FamilyTree } from "./types";

// Compact vertical cards: portrait block on top, name lines, then years.
export const NODE_W = 104; // card width (row axis)
export const NODE_H = 148; // card height (generation axis)
const SPOUSE_GAP = 46; // horizontal gap between spouse cards (the badge sits here)
const SIBLING_GAP = 26;
const GEN_H = 212; // vertical pitch between generation rows
const BLOCK_GAP = 44; // gap between a collateral subtree and the direct line
const BUS_DROP = 26; // how far above a child row its connector bus runs
const ROW_MIN_GAP = 18;
// Siblings/aunts/uncles expand their unit + one generation of children (the
// focus person's nieces/nephews and cousins) and stay collapsed below that.
const COLLATERAL_DEPTH = 1;

export interface PlacedNode {
  person: FamilyPerson;
  x: number; // card center
  y: number; // card center
  gen: number; // generation relative to the focus person (negative = ancestors)
  isFocus: boolean;
}

export interface PlacedUnionDot {
  unionId: string;
  x: number;
  y: number;
}

export interface ChartLayout {
  nodes: PlacedNode[];
  dots: PlacedUnionDot[];
  edgePaths: string[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

interface Indexes {
  personById: Map<string, FamilyPerson>;
  unionsByPartner: Map<string, FamilyTree["unions"]>;
  childrenByUnion: Map<string, string[]>;
  parentUnionOf: Map<string, string>;
  unionById: Map<string, FamilyTree["unions"][number]>;
}

function buildIndexes(tree: FamilyTree): Indexes {
  const personById = new Map(tree.persons.map((p) => [p.id, p]));
  const unionsByPartner = new Map<string, FamilyTree["unions"]>();
  const unionById = new Map(tree.unions.map((u) => [u.id, u]));
  for (const union of tree.unions) {
    for (const pid of [union.person1Id, union.person2Id]) {
      if (!pid) continue;
      const list = unionsByPartner.get(pid) ?? [];
      list.push(union);
      unionsByPartner.set(pid, list);
    }
  }
  const childrenByUnion = new Map<string, string[]>();
  const parentUnionOf = new Map<string, string>();
  const birthOf = (id: string) => personById.get(id)?.birthDate ?? "9999";
  for (const link of tree.children) {
    const list = childrenByUnion.get(link.unionId) ?? [];
    list.push(link.childId);
    childrenByUnion.set(link.unionId, list);
    // v1 guarantees one parent-union per child; keep the first if data disagrees.
    if (!parentUnionOf.has(link.childId)) parentUnionOf.set(link.childId, link.unionId);
  }
  for (const [unionId, kids] of childrenByUnion) {
    childrenByUnion.set(unionId, [...kids].sort((a, b) => birthOf(a).localeCompare(birthOf(b))));
  }
  return { personById, unionsByPartner, childrenByUnion, parentUnionOf, unionById };
}

// Pick a sensible default focus: the person with the largest connected blob is
// overkill — prefer someone in a union (tree-shaped data), else the first person.
export function defaultFocusId(tree: FamilyTree): string | null {
  if (tree.persons.length === 0) return null;
  return tree.unions[0]?.person1Id ?? tree.persons[0].id;
}

export function computeChartLayout(tree: FamilyTree, focusId: string): ChartLayout {
  const ix = buildIndexes(tree);
  const focus = ix.personById.get(focusId) ?? ix.personById.get(defaultFocusId(tree) ?? "");
  if (!focus) {
    return { nodes: [], dots: [], edgePaths: [], bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } };
  }

  const placed = new Map<string, PlacedNode>();
  // `extent` is the row-axis coordinate (screen X); the generation index
  // becomes the row's Y.
  const place = (person: FamilyPerson, extent: number, gen: number) => {
    if (placed.has(person.id)) return;
    placed.set(person.id, { person, x: extent, y: gen * GEN_H, gen, isFocus: person.id === focus.id });
  };

  // ── Descendant pass ──
  // A "unit" is a person plus their spouses side by side in one row; its
  // children hang in the next row below. `depth` bounds how many generations
  // of children a subtree expands (Infinity for the focus person).
  const unitMembers = (personId: string): string[] => {
    const partners = (ix.unionsByPartner.get(personId) ?? [])
      .map((u) => (u.person1Id === personId ? u.person2Id : u.person1Id))
      .filter((id): id is string => id != null && ix.personById.has(id));
    if (partners.length === 0) return [personId];
    if (partners.length === 1) return [personId, partners[0]];
    // Two unions read best with the person in the middle; extras trail after.
    return [partners[0], personId, ...partners.slice(1)];
  };

  const unitChildren = (personId: string): string[] =>
    (ix.unionsByPartner.get(personId) ?? []).flatMap((u) => ix.childrenByUnion.get(u.id) ?? []);

  const subtreeExtent = (personId: string, seen: Set<string>, depth: number): number => {
    if (seen.has(personId)) return NODE_W; // defensive — data should be acyclic
    seen.add(personId);
    const members = unitMembers(personId);
    const blockE = members.length * NODE_W + (members.length - 1) * SPOUSE_GAP;
    const kids = depth > 0 ? unitChildren(personId) : [];
    const kidsE = kids.length > 0
      ? kids.reduce((sum, kid) => sum + subtreeExtent(kid, seen, depth - 1), 0) + (kids.length - 1) * SIBLING_GAP
      : 0;
    return Math.max(blockE, kidsE);
  };

  const placeSubtree = (personId: string, leftExtent: number, gen: number, seen: Set<string>, depth: number) => {
    if (seen.has(personId)) return;
    seen.add(personId);
    const extent = subtreeExtent(personId, new Set(), depth);
    const members = unitMembers(personId);
    const blockE = members.length * NODE_W + (members.length - 1) * SPOUSE_GAP;
    const kids = depth > 0 ? unitChildren(personId) : [];

    if (kids.length > 0) {
      const kidsE = kids.reduce((sum, kid) => sum + subtreeExtent(kid, new Set(), depth - 1), 0) + (kids.length - 1) * SIBLING_GAP;
      let ce = leftExtent + (extent - kidsE) / 2;
      for (const kid of kids) {
        const kidE = subtreeExtent(kid, new Set(), depth - 1);
        placeSubtree(kid, ce, gen + 1, seen, depth - 1);
        ce += kidE + SIBLING_GAP;
      }
    }

    const blockLeft = leftExtent + (extent - blockE) / 2;
    members.forEach((memberId, i) => {
      const person = ix.personById.get(memberId);
      if (person) place(person, blockLeft + NODE_W / 2 + i * (NODE_W + SPOUSE_GAP), gen);
    });
  };

  placeSubtree(focus.id, -subtreeExtent(focus.id, new Set(), Infinity) / 2, 0, new Set(), Infinity);

  // ── Ancestor pass (pedigree) ──
  // ancSlot(p) = width p's card plus all their ancestors need above it.
  const slotCache = new Map<string, number>();
  const ancSlot = (personId: string, seen: Set<string>): number => {
    if (seen.has(personId)) return NODE_W;
    seen.add(personId);
    const cached = slotCache.get(personId);
    if (cached != null) return cached;
    const unionId = ix.parentUnionOf.get(personId);
    const union = unionId ? ix.unionById.get(unionId) : undefined;
    const parents = union
      ? [union.person1Id, union.person2Id].filter((id): id is string => id != null && ix.personById.has(id))
      : [];
    const slot = parents.length === 0
      ? NODE_W
      : Math.max(NODE_W, parents.reduce((sum, p) => sum + ancSlot(p, seen), 0) + (parents.length - 1) * SPOUSE_GAP);
    slotCache.set(personId, slot);
    return slot;
  };

  // Parents render as an ADJACENT couple centered in the horizontal band their
  // pedigree slot reserves (couples split apart otherwise, leaving the union
  // badge floating over a gap); the elbow connectors drawn later bridge any
  // offset between a couple and its child.
  const placeAncestorCouple = (personId: string, gen: number, bandLeft: number, bandRight: number, seen: Set<string>) => {
    if (seen.has(personId)) return;
    seen.add(personId);
    const unionId = ix.parentUnionOf.get(personId);
    const union = unionId ? ix.unionById.get(unionId) : undefined;
    if (!union) return;
    const parents = [union.person1Id, union.person2Id]
      .filter((id): id is string => id != null && ix.personById.has(id));
    if (parents.length === 0) return;
    const center = (bandLeft + bandRight) / 2;
    const coupleW = parents.length * NODE_W + (parents.length - 1) * SPOUSE_GAP;
    let x = center - coupleW / 2 + NODE_W / 2;
    for (const parentId of parents) {
      place(ix.personById.get(parentId)!, x, gen - 1);
      x += NODE_W + SPOUSE_GAP;
    }
    const slots = parents.map((p) => ancSlot(p, new Set()));
    const total = slots.reduce((a, b) => a + b, 0) + (parents.length - 1) * SPOUSE_GAP;
    let left = center - total / 2;
    parents.forEach((parentId, i) => {
      placeAncestorCouple(parentId, gen - 1, left, left + slots[i], seen);
      left += slots[i] + SPOUSE_GAP;
    });
  };
  {
    const focusNode = placed.get(focus.id);
    if (focusNode) {
      const rootSlot = ancSlot(focus.id, new Set());
      placeAncestorCouple(focus.id, 0, focusNode.x - rootSlot / 2, focusNode.x + rootSlot / 2, new Set());
    }
  }

  // ── Collateral pass ──
  // For every person on the direct line (focus + ancestors), lay their
  // siblings out beside the line on the same generation row: siblings of a
  // left-hand spouse extend leftward, of a right-hand spouse rightward. Each
  // sibling gets a depth-limited subtree (spouses + children), so cousins land
  // on the focus person's row and nieces/nephews on the children's row.
  const directLine: { id: string; gen: number }[] = [];
  {
    const seen = new Set<string>();
    let frontier = [{ id: focus.id, gen: 0 }];
    while (frontier.length > 0) {
      const next: typeof frontier = [];
      for (const entry of frontier) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        directLine.push(entry);
        const unionId = ix.parentUnionOf.get(entry.id);
        const union = unionId ? ix.unionById.get(unionId) : undefined;
        for (const pid of union ? [union.person1Id, union.person2Id] : []) {
          if (pid && ix.personById.has(pid)) next.push({ id: pid, gen: entry.gen - 1 });
        }
      }
      frontier = next;
    }
  }

  for (const { id, gen } of directLine) {
    const node = placed.get(id);
    const unionId = ix.parentUnionOf.get(id);
    if (!node || !unionId) continue;
    const siblings = (ix.childrenByUnion.get(unionId) ?? []).filter((sid) => sid !== id && !placed.has(sid));
    if (siblings.length === 0) continue;

    // Which side of their couple does this person sit on? Siblings extend away
    // from the spouse so they don't wedge into the couple.
    const spouse = (ix.unionsByPartner.get(id) ?? [])
      .map((u) => (u.person1Id === id ? u.person2Id : u.person1Id))
      .map((sid) => (sid ? placed.get(sid) : undefined))
      .find((n) => n != null && n.gen === gen);
    const dir = spouse && node.x > spouse.x ? 1 : -1;

    // Anchor outside everything already occupying the rows this subtree spans.
    const ordered = dir < 0 ? [...siblings].reverse() : siblings;
    for (const siblingId of ordered) {
      let minX = Infinity;
      let maxX = -Infinity;
      for (const n of placed.values()) {
        if (n.gen < gen || n.gen > gen + COLLATERAL_DEPTH) continue;
        minX = Math.min(minX, n.x - NODE_W / 2);
        maxX = Math.max(maxX, n.x + NODE_W / 2);
      }
      const extent = subtreeExtent(siblingId, new Set(), COLLATERAL_DEPTH);
      const left = dir < 0 ? minX - BLOCK_GAP - extent : maxX + BLOCK_GAP;
      placeSubtree(siblingId, left, gen, new Set(), COLLATERAL_DEPTH);
    }
  }

  // ── Per-row overlap sweep ──
  // The passes anchor independently, so cards in one row can collide. Push
  // colliding cards right, keeping left-to-right order.
  const rowsMap = new Map<number, PlacedNode[]>();
  for (const node of placed.values()) {
    const row = rowsMap.get(node.gen) ?? [];
    row.push(node);
    rowsMap.set(node.gen, row);
  }
  for (const row of rowsMap.values()) {
    row.sort((a, b) => a.x - b.x);
    for (let i = 1; i < row.length; i++) {
      const minX = row[i - 1].x + NODE_W + ROW_MIN_GAP;
      if (row[i].x < minX) row[i].x = minX;
    }
  }

  // ── Union badges + edges, from final positions ──
  const dots: PlacedUnionDot[] = [];
  const edgePaths: string[] = [];
  for (const union of tree.unions) {
    const p1 = union.person1Id ? placed.get(union.person1Id) : undefined;
    const p2 = union.person2Id ? placed.get(union.person2Id) : undefined;
    let dot: PlacedUnionDot | null = null;
    if (p1 && p2 && p1.gen === p2.gen) {
      const [left, right] = p1.x <= p2.x ? [p1, p2] : [p2, p1];
      dot = { unionId: union.id, x: (left.x + right.x) / 2, y: left.y };
      edgePaths.push(`M ${left.x + NODE_W / 2} ${left.y} H ${right.x - NODE_W / 2}`);
    } else {
      const solo = p1 ?? p2;
      if (solo) dot = { unionId: union.id, x: solo.x, y: solo.y + NODE_H / 2 + 12 };
    }
    if (!dot) continue;

    const kids = (ix.childrenByUnion.get(union.id) ?? [])
      .map((id) => placed.get(id))
      .filter((n): n is PlacedNode => n != null && n.y > dot!.y);
    if (kids.length > 0) {
      const busY = Math.min(...kids.map((k) => k.y)) - NODE_H / 2 - BUS_DROP;
      const xs = [...kids.map((k) => k.x), dot.x];
      edgePaths.push(`M ${dot.x} ${dot.y} V ${busY}`);
      edgePaths.push(`M ${Math.min(...xs)} ${busY} H ${Math.max(...xs)}`);
      for (const kid of kids) {
        edgePaths.push(`M ${kid.x} ${busY} V ${kid.y - NODE_H / 2}`);
      }
    }
    if (kids.length > 0 || (p1 && p2)) dots.push(dot);
  }

  const nodes = [...placed.values()];
  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  const pad = 96;
  return {
    nodes,
    dots,
    edgePaths,
    bounds: {
      minX: Math.min(...xs) - NODE_W / 2 - pad,
      minY: Math.min(...ys) - NODE_H / 2 - pad,
      maxX: Math.max(...xs) + NODE_W / 2 + pad,
      maxY: Math.max(...ys) + NODE_H / 2 + pad
    }
  };
}
