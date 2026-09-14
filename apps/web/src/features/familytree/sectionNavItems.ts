import { MapPinned, Network, Users, UsersRound } from "lucide-react";
import i18n from "../../i18n";
import type { SectionNavItem } from "../../shared/SectionNav";

// Four destinations, and that is the whole section: the chart, everyone in it,
// the family names it groups them under, and the map of where it all happened. Each is already a real address, so
// unlike the gallery this nav needed no routes invented for it.
//
// A person's profile and their photo page are levels BELOW People, not entries
// of their own — they keep People lit and carry their own Back button, the same
// arrangement Series detail has under Audiobooks.
//
// Built fresh on every call (not a module-level const) so the labels stay
// reactive to a language switch — same approach as control/nav.ts.
function familyNavItems(): SectionNavItem[] {
  return [
    { key: "chart", label: i18n.t("family:nav.chart"), href: "/family", icon: Network },
    { key: "people", label: i18n.t("family:people.title"), href: "/family/people", icon: UsersRound },
    { key: "families", label: i18n.t("family:families.title"), href: "/family/families", icon: Users },
    { key: "map", label: i18n.t("family:map.title"), href: "/family/map", icon: MapPinned }
  ];
}

export type FamilySection = "chart" | "people" | "families" | "map";

/** The section's whole SectionNav configuration, so no page restates the label. */
export function familyNavProps(active: FamilySection) {
  return {
    ariaLabel: i18n.t("nav.familyTree"),
    groupLabel: i18n.t("nav.familyTree"),
    items: familyNavItems(),
    activeKey: active
  };
}
