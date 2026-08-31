import { useTranslation } from "react-i18next";
import { Field } from "../../../shared/Field";
import type { PublicRole, LibraryMode } from "../../audiobooks/types";
import type { ManagedUser, ManagedGroup } from "../types";
import { OwnerSelect, VisibilitySelect, PublicRoleSelect, ModeSelect } from "./access-selects";

// Access fields shared by every library type: owner, visibility, public role, mode.
// The create wizard renders these on their own step; edit dialogs use
// LibraryCoreFields below, which adds the name field on top.
export function LibraryAccessFields({
  ownerId, ownerType, onOwnerChange,
  visibility, onVisibilityChange,
  publicRole, onPublicRoleChange,
  mode, onModeChange,
  users, groups
}: {
  ownerId: string;
  ownerType: "user" | "group" | "";
  onOwnerChange: (ownerType: "user" | "group" | "", ownerId: string) => void;
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
    <>
      <label className="field">
        <span>{t("control:libraries.fieldOwner")}</span>
        <OwnerSelect ownerId={ownerId} ownerType={ownerType} onChange={onOwnerChange} users={users} groups={groups} />
      </label>
      <label className="field">
        <span>{t("control:libraries.visibilityLabel")}</span>
        <VisibilitySelect value={visibility} onChange={onVisibilityChange} />
      </label>
      {visibility === "public" && (
        <label className="field">
          <span>{t("control:libraryMembers.publicAccess")}</span>
          <PublicRoleSelect value={publicRole} onChange={onPublicRoleChange} />
        </label>
      )}
      <label className="field">
        <span>{t("control:libraries.fieldMode")}</span>
        <ModeSelect value={mode} onChange={onModeChange} />
      </label>
    </>
  );
}

// Name + access fields, used by the edit dialogs.
export function LibraryCoreFields({
  name, onNameChange,
  ...accessProps
}: {
  name: string;
  onNameChange: (value: string) => void;
} & Parameters<typeof LibraryAccessFields>[0]) {
  const { t } = useTranslation(["common", "control"]);
  return (
    <>
      <Field label={t("control:libraries.libraryName")} value={name} onChange={onNameChange} />
      <LibraryAccessFields {...accessProps} />
    </>
  );
}
