// Single source of truth for the library access <select>s (owner, visibility, public
// role, mode). Both layouts that show them — the create wizard's icon rows and the edit
// dialog's plain fields — embed these, so the option text can't drift between the two.
import type { ReactNode } from "react";
import { Eye, Globe2, Shield, UserRound, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PublicRole, LibraryMode } from "../../audiobooks/types";
import { PUBLIC_ROLE_OPTIONS } from "../../audiobooks/types";
import type { ManagedUser, ManagedGroup } from "../types";
// Plain lookup functions rather than module-level consts, so a language switch
// is picked up (docs/i18n-plan.md's namespace-key typing pitfall #3).
import i18n from "../../../i18n";

type OwnerType = "user" | "group" | "";

// Translated label for a PUBLIC_ROLE_OPTIONS value. types.ts (out of this batch's
// scope) still owns the option list itself (the `value`s), but its English `label`
// strings are never read — every render site sources the label from here instead.
export function publicRoleLabel(value: PublicRole): string {
  switch (value) {
    case "viewer": return i18n.t("control:libraries.publicRoleViewer");
    case "member": return i18n.t("control:libraries.publicRoleMember");
    case "contributor": return i18n.t("control:libraries.publicRoleContributor");
  }
}

export function OwnerSelect({
  ownerId,
  ownerType,
  onChange,
  users,
  groups,
  compactLabels = false
}: {
  ownerId: string;
  ownerType: OwnerType;
  onChange: (ownerType: OwnerType, ownerId: string) => void;
  users: ManagedUser[];
  groups: ManagedGroup[];
  compactLabels?: boolean;
}) {
  const { t } = useTranslation(["common", "control"]);
  return (
    <select
      value={ownerId ? `${ownerType}:${ownerId}` : ""}
      onChange={(event) => {
        const val = event.target.value;
        if (!val) { onChange("", ""); return; }
        const [type, id] = val.split(":");
        onChange(type as "user" | "group", id);
      }}
    >
      <option value="">{t("control:libraries.noOwnerOption")}</option>
      {users.length > 0 && (
        <optgroup label={t("control:libraryMembers.optgroupUsers")}>
          {users.map((user) => (
            <option value={`user:${user.id}`} key={user.id}>
              {compactLabels ? user.displayName : `${user.displayName} (${user.email})`}
            </option>
          ))}
        </optgroup>
      )}
      {groups.length > 0 && (
        <optgroup label={t("control:libraryMembers.optgroupGroups")}>
          {groups.map((group) => (
            <option value={`group:${group.id}`} key={group.id}>{group.name}</option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

export function VisibilitySelect({
  value,
  onChange
}: {
  value: "public" | "private";
  onChange: (value: "public" | "private") => void;
}) {
  const { t } = useTranslation(["common", "control"]);
  return (
    <select value={value} onChange={(event) => onChange(event.target.value as "public" | "private")}>
      <option value="public">{t("control:libraries.publicOptionFull")}</option>
      <option value="private">{t("control:libraries.privateOptionFull")}</option>
    </select>
  );
}

export function PublicRoleSelect({
  value,
  onChange
}: {
  value: PublicRole;
  onChange: (value: PublicRole) => void;
}) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value as PublicRole)}>
      {PUBLIC_ROLE_OPTIONS.map((option) => (
        <option value={option.value} key={option.value}>{publicRoleLabel(option.value)}</option>
      ))}
    </select>
  );
}

export function ModeSelect({
  value,
  onChange
}: {
  value: LibraryMode;
  onChange: (value: LibraryMode) => void;
}) {
  const { t } = useTranslation(["common", "control"]);
  return (
    <select value={value} onChange={(event) => onChange(event.target.value as LibraryMode)}>
      <option value="managed">{t("control:libraries.modeManagedFull")}</option>
      <option value="external">{t("control:libraries.modeExternalFull")}</option>
    </select>
  );
}

// Icon-row access fields (owner / visibility / public role / mode) shared by the create
// wizard's Access step and the edit-library dialog's Access tab. Hosts supply their own
// surrounding section/heading.
export function LibraryAccessRows({
  ownerId, ownerType, onOwnerChange,
  visibility, onVisibilityChange,
  publicRole, onPublicRoleChange,
  mode, onModeChange,
  users, groups
}: {
  ownerId: string;
  ownerType: OwnerType;
  onOwnerChange: (ownerType: OwnerType, ownerId: string) => void;
  visibility: "public" | "private";
  onVisibilityChange: (value: "public" | "private") => void;
  publicRole: PublicRole;
  onPublicRoleChange: (value: PublicRole) => void;
  mode: LibraryMode;
  onModeChange: (value: LibraryMode) => void;
  users: ManagedUser[];
  groups: ManagedGroup[];
}) {
  const { t } = useTranslation(["common", "control"]);
  return (
    <div className="library-access-list">
      <AccessSettingRow icon={UserRound} title={t("control:libraries.fieldOwner")} description={t("control:libraries.ownerRowDescription")}>
        <OwnerSelect ownerId={ownerId} ownerType={ownerType} onChange={onOwnerChange} users={users} groups={groups} />
      </AccessSettingRow>

      <AccessSettingRow icon={Globe2} title={t("control:libraries.visibilityLabel")} description={t("control:libraries.visibilityRowDescription")}>
        <VisibilitySelect value={visibility} onChange={onVisibilityChange} />
      </AccessSettingRow>

      {visibility === "public" && (
        <AccessSettingRow icon={Eye} title={t("control:libraryMembers.publicAccess")} description={t("control:libraries.publicAccessRowDescription")}>
          <PublicRoleSelect value={publicRole} onChange={onPublicRoleChange} />
        </AccessSettingRow>
      )}

      <AccessSettingRow icon={Shield} title={t("control:libraries.fieldMode")} description={t("control:libraries.modeRowDescription")}>
        <ModeSelect value={mode} onChange={onModeChange} />
      </AccessSettingRow>
    </div>
  );
}

function AccessSettingRow({
  icon: Icon,
  title,
  description,
  children
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="library-access-row">
      <span className="library-access-icon" aria-hidden="true">
        <Icon size={28} />
      </span>
      <span className="library-access-copy">
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <label className="library-access-control">
        <span className="sr-only">{title}</span>
        {children}
      </label>
    </div>
  );
}
