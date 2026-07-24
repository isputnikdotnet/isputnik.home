// Person-centered chart layout: pure geometry, no React. Given the whole tree
// and a focus person, produces positioned cards, union dots, and edge paths:
//
//   • the focus person with their spouses side by side, descendants laid out
//     below (classic recursive subtree widths, parents centered over children);
//   • ancestors above in pedigree style (each parent couple centered over the
//     slot its own ancestors need);
//   • the focus person's siblings beside them (cards only — their descendants
//     stay collapsed to bound the width).
//
// Positions are computed first, then a per-row sweep resolves any overlap
// between the independently-anchored ancestor/descendant passes, and edges are
// drawn last from the final positions — so edges can never detach.
import type { FamilyPerson, FamilyTree } from "./types";

export const NODE_W = 130;
export const NODE_H = 50;
const SPOUSE_GAP = 28;
const SIBLING_GAP = 22;
const ROW_H = 132;
const BLOCK_GAP = 36;
const BUS_RISE = 20; // how far above a child row its connector bus runs

export interface PlacedNode {
  person: FamilyPerson;
  x: number; // card center
  y: number; // card center
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
  if (!focus) return { nodes: [], dots: [], edgePaths: [], bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } };

  const placed = new Map<string, PlacedNode>();
  const place = (person: FamilyPerson, x: number, gen: number) => {
    if (placed.has(person.id)) return;
    placed.set(person.id, { person, x, y: gen * ROW_H, isFocus: person.id === focus.id });
  };

  // ── Descendant pass ──
  // A "unit" is a person plus their spouses in one row; its children hang below.
  const unitMembers = (personId: string): string[] => {
    const partners = (ix.unionsByPartner.get(personId) ?? [])
      .map((u) => (u.person1Id === personId ? u.person2Id : u.person1Id))
      .filter((id): id is string => id != null && ix.personById.has(id));
    if (partners.length === 0) return [personId];
    if (partners.length === 1) return [personId, partners[0]];
    // Two unions read best with the person in the middle; extras go right.
    return [partners[0], personId, ...partners.slice(1)];
  };

  const unitChildren = (personId: string): string[] =>
    (ix.unionsByPartner.get(personId) ?? []).flatMap((u) => ix.childrenByUnion.get(u.id) ?? []);

  const widthCache = new Map<string, number>();
  const subtreeWidth = (personId: string, seen: Set<string>): number => {
    if (seen.has(personId)) return NODE_W; // defensive — data should be acyclic
    seen.add(personId);
    const cached = widthCache.get(personId);
    if (cached != null) return cached;
    const members = unitMembers(personId);
    const blockW = members.length * NODE_W + (members.length - 1) * SPOUSE_GAP;
    const kids = unitChildren(personId);
    const kidsW = kids.length > 0
      ? kids.reduce((sum, kid) => sum + subtreeWidth(kid, seen), 0) + (kids.length - 1) * SIBLING_GAP
      : 0;
    const width = Math.max(blockW, kidsW);
    widthCache.set(personId, width);
    return width;
  };

  const placeSubtree = (personId: string, leftX: number, gen: number, seen: Set<string>) => {
    if (seen.has(personId)) return;
    seen.add(personId);
    const width = subtreeWidth(personId, new Set());
    const members = unitMembers(personId);
    const blockW = members.length * NODE_W + (members.length - 1) * SPOUSE_GAP;
    const kids = unitChildren(personId);

    if (kids.length > 0) {
      const kidsW = kids.reduce((sum, kid) => sum + subtreeWidth(kid, new Set()), 0) + (kids.length - 1) * SIBLING_GAP;
      let cx = leftX + (width - kidsW) / 2;
      for (const kid of kids) {
        const kidW = subtreeWidth(kid, new Set());
        placeSubtree(kid, cx, gen + 1, seen);
        cx += kidW + SIBLING_GAP;
      }
    }

    const blockLeft = leftX + (width - blockW) / 2;
    members.forEach((memberId, i) => {
      const person = ix.personById.get(memberId);
      if (person) place(person, blockLeft + NODE_W / 2 + i * (NODE_W + SPOUSE_GAP), gen);
    });
  };

  const focusWidth = subtreeWidth(focus.id, new Set());
  placeSubtree(focus.id, -focusWidth / 2, 0, new Set());

  // ── Sibling pass ──
  // Focus siblings render as collapsed cards left of the focus unit, oldest first.
  const parentUnionId = ix.parentUnionOf.get(focus.id);
  if (parentUnionId) {
    const siblings = (ix.childrenByUnion.get(parentUnionId) ?? []).filter((id) => id !== focus.id);
    const focusUnitLeft = Math.min(
      ...unitMembers(focus.id).map((id) => placed.get(id)?.x ?? Infinity)
    ) - NODE_W / 2;
    let x = focusUnitLeft - BLOCK_GAP - (siblings.length - 1) * (NODE_W + SIBLING_GAP) - NODE_W / 2;
    for (const siblingId of siblings) {
      const person = ix.personById.get(siblingId);
      if (person && !placed.has(siblingId)) {
        place(person, x, 0);
        x += NODE_W + SIBLING_GAP;
      }
    }
  }

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
    let left = child.x - total / 2;
    for (const parentId of parents) {
      const slot = ancSlot(parentId, new Set());
      const person = ix.personById.get(parentId)!;
      place(person, left + slot / 2, gen - 1);
      left += slot + SPOUSE_GAP;
    }
    for (const parentId of parents) placeAncestors(parentId, gen - 1, seen);
  };
  placeAncestors(focus.id, 0, new Set());

  // ── Per-row overlap sweep ──
  // The passes anchor independently, so cards in one row can collide. Push
  // colliding cards right, keeping left-to-right order.
  const rows = new Map<number, PlacedNode[]>();
  for (const node of placed.values()) {
    const row = rows.get(node.y) ?? [];
    row.push(node);
    rows.set(node.y, row);
  }
  for (const row of rows.values()) {
    row.sort((a, b) => a.x - b.x);
    for (let i = 1; i < row.length; i++) {
      const minX = row[i - 1].x + NODE_W + 18;
      if (row[i].x < minX) row[i].x = minX;
    }
  }

  // ── Union dots + edges, from final positions ──
  const dots: PlacedUnionDot[] = [];
  const edgePaths: string[] = [];
  for (const union of tree.unions) {
    const p1 = union.person1Id ? placed.get(union.person1Id) : undefined;
    const p2 = union.person2Id ? placed.get(union.person2Id) : undefined;
    let dot: PlacedUnionDot | null = null;
    if (p1 && p2 && p1.y === p2.y) {
      const [left, right] = p1.x <= p2.x ? [p1, p2] : [p2, p1];
      dot = { unionId: union.id, x: (left.x + right.x) / 2, y: left.y };
      edgePaths.push(`M ${left.x + NODE_W / 2} ${left.y} H ${right.x - NODE_W / 2}`);
    } else {
      const solo = p1 ?? p2;
      if (solo) dot = { unionId: union.id, x: solo.x, y: solo.y + NODE_H / 2 + 10 };
    }
    if (!dot) continue;

    const kids = (ix.childrenByUnion.get(union.id) ?? [])
      .map((id) => placed.get(id))
      .filter((n): n is PlacedNode => n != null && n.y > dot!.y);
    if (kids.length > 0) {
      const busY = Math.min(...kids.map((k) => k.y)) - NODE_H / 2 - BUS_RISE;
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
  const pad = 60;
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
