// Person-centered chart layout: pure geometry, no React. Generations flow
// LEFT → RIGHT (ancestors left, descendants right) and each generation is a
// column in which cards stack vertically — spouses adjacent with the union
// badge between them. Given the whole tree and a focus person, produces
// positioned cards, union badges, and edge paths:
//
//   • the focus person with their spouses stacked together, descendants laid
//     out to the right (classic recursive subtree extents, parents centered
//     beside their children);
//   • ancestors to the left in pedigree style (each parent couple centered
//     beside the slot its own ancestors need);
//   • the focus person's siblings above them (cards only — their descendants
//     stay collapsed to bound the height).
//
// Internally the math packs along one scalar axis ("extent" = screen Y) per
// generation; positions are computed first, then a per-column sweep resolves
// any overlap between the independently-anchored ancestor/descendant passes,
// and edges are drawn last from the final positions — so edges can never
// detach.
import type { FamilyPerson, FamilyTree } from "./types";

// Vertical cards: portrait on top, name, then dates.
export const NODE_W = 156; // card width (generation axis)
export const NODE_H = 148; // card height (stacking axis)
const SPOUSE_GAP = 42; // vertical gap between spouse cards (the badge sits here)
const SIBLING_GAP = 28;
const GEN_W = 238; // horizontal pitch between generation columns
const BLOCK_GAP = 46;
const BUS_RISE = 34; // how far left of a child column its connector bus runs

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
  // `extent` is the stacking-axis coordinate (screen Y); the generation index
  // becomes the column's X.
  const place = (person: FamilyPerson, extent: number, gen: number) => {
    if (placed.has(person.id)) return;
    placed.set(person.id, { person, x: gen * GEN_W, y: extent, gen, isFocus: person.id === focus.id });
  };

  // ── Descendant pass ──
  // A "unit" is a person plus their spouses stacked in one column; its
  // children hang in the next column to the right.
  const unitMembers = (personId: string): string[] => {
    const partners = (ix.unionsByPartner.get(personId) ?? [])
      .map((u) => (u.person1Id === personId ? u.person2Id : u.person1Id))
      .filter((id): id is string => id != null && ix.personById.has(id));
    if (partners.length === 0) return [personId];
    if (partners.length === 1) return [personId, partners[0]];
    // Two unions read best with the person in the middle; extras stack below.
    return [partners[0], personId, ...partners.slice(1)];
  };

  const unitChildren = (personId: string): string[] =>
    (ix.unionsByPartner.get(personId) ?? []).flatMap((u) => ix.childrenByUnion.get(u.id) ?? []);

  const extentCache = new Map<string, number>();
  const subtreeExtent = (personId: string, seen: Set<string>): number => {
    if (seen.has(personId)) return NODE_H; // defensive — data should be acyclic
    seen.add(personId);
    const cached = extentCache.get(personId);
    if (cached != null) return cached;
    const members = unitMembers(personId);
    const blockE = members.length * NODE_H + (members.length - 1) * SPOUSE_GAP;
    const kids = unitChildren(personId);
    const kidsE = kids.length > 0
      ? kids.reduce((sum, kid) => sum + subtreeExtent(kid, seen), 0) + (kids.length - 1) * SIBLING_GAP
      : 0;
    const extent = Math.max(blockE, kidsE);
    extentCache.set(personId, extent);
    return extent;
  };

  const placeSubtree = (personId: string, topExtent: number, gen: number, seen: Set<string>) => {
    if (seen.has(personId)) return;
    seen.add(personId);
    const extent = subtreeExtent(personId, new Set());
    const members = unitMembers(personId);
    const blockE = members.length * NODE_H + (members.length - 1) * SPOUSE_GAP;
    const kids = unitChildren(personId);

    if (kids.length > 0) {
      const kidsE = kids.reduce((sum, kid) => sum + subtreeExtent(kid, new Set()), 0) + (kids.length - 1) * SIBLING_GAP;
      let ce = topExtent + (extent - kidsE) / 2;
      for (const kid of kids) {
        const kidE = subtreeExtent(kid, new Set());
        placeSubtree(kid, ce, gen + 1, seen);
        ce += kidE + SIBLING_GAP;
      }
    }

    const blockTop = topExtent + (extent - blockE) / 2;
    members.forEach((memberId, i) => {
      const person = ix.personById.get(memberId);
      if (person) place(person, blockTop + NODE_H / 2 + i * (NODE_H + SPOUSE_GAP), gen);
    });
  };

  const focusExtent = subtreeExtent(focus.id, new Set());
  placeSubtree(focus.id, -focusExtent / 2, 0, new Set());

  // ── Sibling pass ──
  // Focus siblings render as collapsed cards above the focus unit, oldest first.
  const parentUnionId = ix.parentUnionOf.get(focus.id);
  if (parentUnionId) {
    const siblings = (ix.childrenByUnion.get(parentUnionId) ?? []).filter((id) => id !== focus.id);
    const focusUnitTop = Math.min(
      ...unitMembers(focus.id).map((id) => placed.get(id)?.y ?? Infinity)
    ) - NODE_H / 2;
    let e = focusUnitTop - BLOCK_GAP - (siblings.length - 1) * (NODE_H + SIBLING_GAP) - NODE_H / 2;
    for (const siblingId of siblings) {
      const person = ix.personById.get(siblingId);
      if (person && !placed.has(siblingId)) {
        place(person, e, 0);
        e += NODE_H + SIBLING_GAP;
      }
    }
  }

  // ── Ancestor pass (pedigree) ──
  // ancSlot(p) = extent p's card plus all their ancestors need beside it.
  const slotCache = new Map<string, number>();
  const ancSlot = (personId: string, seen: Set<string>): number => {
    if (seen.has(personId)) return NODE_H;
    seen.add(personId);
    const cached = slotCache.get(personId);
    if (cached != null) return cached;
    const unionId = ix.parentUnionOf.get(personId);
    const union = unionId ? ix.unionById.get(unionId) : undefined;
    const parents = union
      ? [union.person1Id, union.person2Id].filter((id): id is string => id != null && ix.personById.has(id))
      : [];
    const slot = parents.length === 0
      ? NODE_H
      : Math.max(NODE_H, parents.reduce((sum, p) => sum + ancSlot(p, seen), 0) + (parents.length - 1) * SPOUSE_GAP);
    slotCache.set(personId, slot);
    return slot;
  };

  const placeAncestors = (personId: string, gen: number, seen: Set<string>) => {
    if (seen.has(personId)) return;
    seen.add(personId);
    const child = placed.get(personId);
    if (!child) return;
    const unionId = ix.parentUnionOf.get(personId);
    const union = unionId ? ix.unionById.get(unionId) : undefined;
    if (!union) return;
    const parents = [union.person1Id, union.person2Id]
      .filter((id): id is string => id != null && ix.personById.has(id));
    if (parents.length === 0) return;
    const total = parents.reduce((sum, p) => sum + ancSlot(p, new Set()), 0) + (parents.length - 1) * SPOUSE_GAP;
    let top = child.y - total / 2;
    for (const parentId of parents) {
      const slot = ancSlot(parentId, new Set());
      const person = ix.personById.get(parentId)!;
      place(person, top + slot / 2, gen - 1);
      top += slot + SPOUSE_GAP;
    }
    for (const parentId of parents) placeAncestors(parentId, gen - 1, seen);
  };
  placeAncestors(focus.id, 0, new Set());

  // ── Per-column overlap sweep ──
  // The passes anchor independently, so cards in one column can collide. Push
  // colliding cards down, keeping top-to-bottom order.
  const columnsMap = new Map<number, PlacedNode[]>();
  for (const node of placed.values()) {
    const column = columnsMap.get(node.gen) ?? [];
    column.push(node);
    columnsMap.set(node.gen, column);
  }
  for (const column of columnsMap.values()) {
    column.sort((a, b) => a.y - b.y);
    for (let i = 1; i < column.length; i++) {
      const minY = column[i - 1].y + NODE_H + 16;
      if (column[i].y < minY) column[i].y = minY;
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
      const [top, bottom] = p1.y <= p2.y ? [p1, p2] : [p2, p1];
      dot = { unionId: union.id, x: top.x, y: (top.y + bottom.y) / 2 };
      edgePaths.push(`M ${top.x} ${top.y + NODE_H / 2} V ${bottom.y - NODE_H / 2}`);
    } else {
      const solo = p1 ?? p2;
      if (solo) dot = { unionId: union.id, x: solo.x + NODE_W / 2 + 12, y: solo.y };
    }
    if (!dot) continue;

    const kids = (ix.childrenByUnion.get(union.id) ?? [])
      .map((id) => placed.get(id))
      .filter((n): n is PlacedNode => n != null && n.x > dot!.x);
    if (kids.length > 0) {
      const busX = Math.min(...kids.map((k) => k.x)) - NODE_W / 2 - BUS_RISE;
      const ys = [...kids.map((k) => k.y), dot.y];
      edgePaths.push(`M ${dot.x} ${dot.y} H ${busX}`);
      edgePaths.push(`M ${busX} ${Math.min(...ys)} V ${Math.max(...ys)}`);
      for (const kid of kids) {
        edgePaths.push(`M ${busX} ${kid.y} H ${kid.x - NODE_W / 2}`);
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
