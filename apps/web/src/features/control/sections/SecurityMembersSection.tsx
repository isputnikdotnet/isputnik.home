import { useTranslation } from "react-i18next";
import { Ban, Gauge, House, LayoutGrid, Link2, ShieldCheck, SlidersHorizontal, UserRound, UsersRound, type LucideIcon } from "lucide-react";
import { controlHref, type ControlSection } from "../../../router";
import { GroupedList, NavRow } from "../../../shared/GroupedList";
import { ControlSectionHead } from "../ControlSectionHead";
import { SECURITY_AREAS, areaLabel, tabLabel } from "../nav";

// Security & Members' directory — what the group opens on, as Applications opens on
// its own (owner, 2026-11-23). Two sections, each a workspace with one short row:
// User Management (who the people are and what they may open) and Security Policies
// (the rules that protect the server). Every page of both is one row here, so
// nothing is more than a click from the group. Sign-ins and Sign-in locations are
// the Dashboard's tabs now, not this group's.

type AreaSection = "users" | "groups" | "invites" | "appsAccess" | "security" | "securityPolicies" | "securityTrusted" | "securityBlocked";

const ROW_ICON: Record<AreaSection, LucideIcon> = {
  users: UserRound,
  groups: UsersRound,
  invites: Link2,
  appsAccess: LayoutGrid,
  security: Gauge,
  securityPolicies: SlidersHorizontal,
  securityTrusted: House,
  securityBlocked: Ban
};

export function SecurityMembersSection() {
  const { t } = useTranslation(["control"]);
  return (
    <>
      <ControlSectionHead section="securityMembers" icon={<ShieldCheck size={30} />} iconClassName="blue" description={t("control:securityMembers.description")} />
      <div className="grouped-page">
        {SECURITY_AREAS.map((area) => (
          <GroupedList key={area.key} title={areaLabel(area.key)}>
            {area.tabs.map((tab) => {
              const section = tab.section as AreaSection & ControlSection;
              const Icon = ROW_ICON[section];
              return <NavRow key={section} icon={<Icon size={18} />} iconTone={area.key === "userManagement" ? "blue" : "gold"}
                label={tabLabel(section)} sub={t(`control:securityMembers.rows.${section}`)} href={controlHref(section)} />;
            })}
          </GroupedList>
        ))}
      </div>
    </>
  );
}
