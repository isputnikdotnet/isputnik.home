// Single source of truth for the library access <select>s (owner, visibility, public
// role, mode). Both layouts that show them — the create wizard's icon rows and the edit
// dialog's plain fields — embed these, so the option text can't drift between the two.
import type { ReactNode } from "react";
import { Eye, Globe2, Shield, UserRound, type LucideIcon } from "lucide-react";
import type { PublicRole, LibraryMode } from "../../audiobooks/types";
import { PUBLIC_ROLE_OPTIONS } from "../../audiobooks/types";
import type { ManagedUser, ManagedGroup } from "../types";

type OwnerType = "user" | "group" | "";

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
      <option value="">No owner (system library)</option>
      {users.length > 0 && (
        <optgroup label="Users">
          {users.map((user) => (
            <option value={`user:${user.id}`} key={user.id}>
              {compactLabels ? user.displayName : `${user.displayName} (${user.email})`}
            </option>
          ))}
        </optgroup>
      )}
      {groups.length > 0 && (
        <optgroup label="Groups">
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
  return (
    <select value={value} onChange={(event) => onChange(event.target.value as "public" | "private")}>
      <option value="public">Public — all users can access</option>
      <option value="private">Private — owner and admins only</option>
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
        <option value={option.value} key={option.value}>{option.label}</option>
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
  return (
    <select value={value} onChange={(event) => onChange(event.target.value as LibraryMode)}>
      <option value="managed">Managed — this app owns the files</option>
      <option value="external">External — read-only, managed outside this app</option>
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
  return (
    <div className="library-access-list">
      <AccessSettingRow icon={UserRound} title="Owner" description="Select who owns this library.">
        <OwnerSelect ownerId={ownerId} ownerType={ownerType} onChange={onOwnerChange} users={users} groups={groups} />
      </AccessSettingRow>

      <AccessSettingRow icon={Globe2} title="Visibility" description="Control who can see this library.">
        <VisibilitySelect value={visibility} onChange={onVisibilityChange} />
      </AccessSettingRow>

      {visibility === "public" && (
        <AccessSettingRow icon={Eye} title="Public access" description="Choose what public users can do.">
          <PublicRoleSelect value={publicRole} onChange={onPublicRoleChange} />
        </AccessSettingRow>
      )}

      <AccessSettingRow icon={Shield} title="Mode" description="Determines who manages the files.">
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
