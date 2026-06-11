import { Field } from "../../../shared/Field";
import type { PublicRole, LibraryMode } from "../../audiobooks/types";
import { PUBLIC_ROLE_OPTIONS } from "../../audiobooks/types";
import type { ManagedUser, ManagedGroup } from "../types";

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
  return (
    <>
      <label className="field">
        <span>Owner</span>
        <select
          value={ownerId ? `${ownerType}:${ownerId}` : ""}
          onChange={(event) => {
            const val = event.target.value;
            if (!val) { onOwnerChange("", ""); return; }
            const [type, id] = val.split(":");
            onOwnerChange(type as "user" | "group", id);
          }}
        >
          <option value="">No owner (system library)</option>
          {users.length > 0 && (
            <optgroup label="Users">
              {users.map((user) => (
                <option value={`user:${user.id}`} key={user.id}>{user.displayName} ({user.email})</option>
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
      </label>
      <label className="field">
        <span>Visibility</span>
        <select value={visibility} onChange={(event) => onVisibilityChange(event.target.value as "public" | "private")}>
          <option value="public">Public — all users can access</option>
          <option value="private">Private — owner and admins only</option>
        </select>
      </label>
      {visibility === "public" && (
        <label className="field">
          <span>Public access</span>
          <select value={publicRole} onChange={(event) => onPublicRoleChange(event.target.value as PublicRole)}>
            {PUBLIC_ROLE_OPTIONS.map((o) => <option value={o.value} key={o.value}>{o.label}</option>)}
          </select>
        </label>
      )}
      <label className="field">
        <span>Mode</span>
        <select value={mode} onChange={(event) => onModeChange(event.target.value as LibraryMode)}>
          <option value="managed">Managed — this app owns the files</option>
          <option value="external">External (read-only) — managed by Plex/Audiobookshelf</option>
        </select>
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
  return (
    <>
      <Field label="Library name" value={name} onChange={onNameChange} />
      <LibraryAccessFields {...accessProps} />
    </>
  );
}
