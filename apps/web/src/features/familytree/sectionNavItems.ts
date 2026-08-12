import { Network, Users, UsersRound } from "lucide-react";
import type { SectionNavItem } from "../../shared/SectionNav";

// Three destinations, and that is the whole section: the chart, everyone in it,
// and the family names it groups them under. Each is already a real address, so
// unlike the gallery this nav needed no routes invented for it.
//
// A person's profile and their photo page are levels BELOW People, not entries
// of their own — they keep People lit and carry their own Back button, the same
// arrangement Series detail has under Audiobooks.
export const FAMILY_NAV_ITEMS: SectionNavItem[] = [
  { key: "chart", label: "Chart", href: "/family", icon: Network },
  { key: "people", label: "People", href: "/family/people", icon: UsersRound },
  { key: "families", label: "Families", href: "/family/families", icon: Users }
];

export type FamilySection = "chart" | "people" | "families";

/** The section's whole SectionNav configuration, so no page restates the label. */
export function familyNavProps(active: FamilySection) {
  return {
    ariaLabel: "Family Tree",
    groupLabel: "Family Tree",
    items: FAMILY_NAV_ITEMS,
    activeKey: active
  };
}
