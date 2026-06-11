import { useState, useEffect, useCallback } from "react";
import { Globe2, Lock, ShieldCheck, Trash2, UserPlus, Users } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import { LIBRARY_ROLE_OPTIONS, type LibraryMember, type LibraryRole, type PublicRole } from "../../audiobooks/types";
import type { ManagedUser, ManagedGroup } from "../types";

// Per-role colour dot + short tagline shown in the role dropdowns. Kept local so the
// shared LIBRARY_ROLE_OPTIONS (used elsewhere) stays untouched.
const ROLE_META: Record<LibraryRole, { tagline: string; dot: string }> = {
  viewer: { tagline: "View only", dot: "#3b82f6" },
  member: { tagline: "View + download", dot: "#8b5cf6" },
  contributor: { tagline: "Upload + edit", dot: "#14b8a6" },
  manager: { tagline: "Full control", dot: "#f59e0b" },
  deny: { tagline: "No access", dot: "#ef4444" }
};

const PUBLIC_DESCRIPTION: Record<PublicRole, string> = {
  viewer: "Everyone can view this library.",
  member: "Everyone can view and download from this library.",
  contributor: "Everyone can view, download, and add content."
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

// Stable hue per name so each user avatar has its own colour across reloads.
function hueFromString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) % 360;
  return hash;
}

function RoleControl({
  value,
  disabled,
  onChange
}: {
  value: LibraryRole;
  disabled?: boolean;
  onChange?: (role: LibraryRole) => void;
}) {
  return (
    <div className={`member-role-control${disabled ? " is-locked" : ""}`}>
      <span className="member-role-dot" style={{ background: ROLE_META[value].dot }} aria-hidden="true" />
      <select
        value={value}
        disabled={disabled}
        onChange={onChange ? (event) => onChange(event.target.value as LibraryRole) : undefined}
        aria-label="Role"
      >
        {LIBRARY_ROLE_OPTIONS.map((option) => (
          <option value={option.value} key={option.value}>{option.label} ({ROLE_META[option.value].tagline})</option>
        ))}
      </select>
    </div>
  );
}

export function LibraryMembersModal({
  library,
  users,
  groups,
  onClose
}: {
  library: { id: string; name: string; visibility: "public" | "private"; publicRole: PublicRole };
  users: ManagedUser[];
  groups: ManagedGroup[];
  onClose: () => void;
}) {
  const [members, setMembers] = useState<LibraryMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [subject, setSubject] = useState("");
  const [role, setRole] = useState<LibraryRole>("member");
  const [saving, setSaving] = useState(false);

  const isPublic = library.visibility === "public";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await api<{ members: LibraryMember[] }>(`/api/library/libraries/${library.id}/members`);
      setMembers(payload.members);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load members");
    } finally {
      setLoading(false);
    }
  }, [library.id]);

  useEffect(() => {
    load();
  }, [load]);

  const addGrant = async () => {
    if (!subject) {
      setError("Choose a user or group to grant a role.");
      return;
    }
    const [subjectType, subjectId] = subject.split(":");
    setSaving(true);
    setError("");
    try {
      await api(`/api/library/libraries/${library.id}/members`, {
        method: "POST",
        body: JSON.stringify({ subjectType, subjectId, role })
      });
      setSubject("");
      setRole("member");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to grant role");
    } finally {
      setSaving(false);
    }
  };

  // Roles upsert server-side (POST with a new role replaces it), so the row dropdown
  // can change a member's role in place.
  const changeRole = async (member: LibraryMember, nextRole: LibraryRole) => {
    if (nextRole === member.role) return;
    setSaving(true);
    setError("");
    try {
      await api(`/api/library/libraries/${library.id}/members`, {
        method: "POST",
        body: JSON.stringify({ subjectType: member.subjectType, subjectId: member.subjectId, role: nextRole })
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update role");
    } finally {
      setSaving(false);
    }
  };

  const revoke = async (member: LibraryMember) => {
    setSaving(true);
    setError("");
    try {
      await api(`/api/library/libraries/${library.id}/members/${member.subjectType}/${member.subjectId}`, {
        method: "DELETE"
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to revoke role");
    } finally {
      setSaving(false);
    }
  };

  const groupMemberCount = (id: string) => groups.find((group) => group.id === id)?.memberCount;

  return (
    <Modal
      title={`Members — ${library.name}`}
      className="library-members-modal"
      busy={saving}
      onClose={onClose}
    >
      <div className={`member-banner ${isPublic ? "is-public" : "is-private"}`}>
        <span className="member-banner-icon" aria-hidden="true">
          {isPublic ? <Globe2 size={22} /> : <Lock size={20} />}
        </span>
        <div className="member-banner-copy">
          <strong>{isPublic ? "This library is public." : "This library is private."}</strong>
          <span>
            {isPublic
              ? PUBLIC_DESCRIPTION[library.publicRole] ?? "Everyone can access this library."
              : "Only the owner, admins, and the people you add below can access it."}
          </span>
        </div>
        <span className="member-banner-pill">{isPublic ? "Public access" : "Private"}</span>
      </div>

      <section className="member-section">
        <h3 className="member-section-title">Grant access</h3>
        <div className="member-grant">
          <div className="member-field member-field-grow">
            <Users size={17} className="member-field-icon" aria-hidden="true" />
            <select value={subject} onChange={(event) => setSubject(event.target.value)} aria-label="User or group">
              <option value="">Select a user or group…</option>
              {users.length > 0 && (
                <optgroup label="Users">
                  {users.map((user) => (
                    <option value={`user:${user.id}`} key={`u-${user.id}`}>{user.displayName} ({user.email})</option>
                  ))}
                </optgroup>
              )}
              {groups.length > 0 && (
                <optgroup label="Groups">
                  {groups.map((group) => (
                    <option value={`group:${group.id}`} key={`g-${group.id}`}>{group.name}</option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>
          <div className="member-field">
            <ShieldCheck size={17} className="member-field-icon" aria-hidden="true" />
            <select value={role} onChange={(event) => setRole(event.target.value as LibraryRole)} aria-label="Role to grant">
              {LIBRARY_ROLE_OPTIONS.map((option) => (
                <option value={option.value} key={option.value}>{option.label} ({ROLE_META[option.value].tagline})</option>
              ))}
            </select>
          </div>
          <Button variant="primary" onClick={addGrant} disabled={saving || !subject}>
            <UserPlus size={16} aria-hidden="true" />
            <span>Add</span>
          </Button>
        </div>
      </section>

      {error && <MessageBox tone="error" title="Members error">{error}</MessageBox>}

      <section className="member-section">
        <h3 className="member-section-title">Members with access</h3>
        {loading ? (
          <p className="management-empty">Loading members…</p>
        ) : (
          <div className="member-rows">
            {members.map((member) => {
              const isGroup = member.subjectType === "group";
              const count = isGroup ? groupMemberCount(member.subjectId) : undefined;
              return (
                <div className="member-row" key={`${member.subjectType}:${member.subjectId}`}>
                  {isGroup ? (
                    <span className="member-avatar member-avatar-neutral" aria-hidden="true"><Users size={18} /></span>
                  ) : (
                    <span
                      className="member-avatar"
                      style={{ background: `hsl(${hueFromString(member.name)}, 58%, 52%)` }}
                      aria-hidden="true"
                    >
                      {initials(member.name)}
                    </span>
                  )}
                  <div className="member-identity">
                    <span className="member-name">{member.name}{member.missing ? " (deleted)" : ""}</span>
                    <span className="member-sub">
                      {isGroup
                        ? (count != null ? `${count} member${count === 1 ? "" : "s"}` : "Group")
                        : (member.email ?? "User")}
                    </span>
                  </div>
                  <RoleControl
                    value={member.role}
                    disabled={saving || member.missing}
                    onChange={(next) => changeRole(member, next)}
                  />
                  <Button
                    variant="icon"
                    danger
                    title={`Remove ${member.name}`}
                    aria-label={`Remove ${member.name}`}
                    onClick={() => revoke(member)}
                    disabled={saving}
                  >
                    <Trash2 size={15} />
                  </Button>
                </div>
              );
            })}

            {members.length === 0 && (
              <p className="member-empty">No individual users or groups added yet.</p>
            )}

            <div className="member-row member-row-everyone">
              <span className="member-avatar member-avatar-neutral" aria-hidden="true"><Globe2 size={18} /></span>
              <div className="member-identity">
                <span className="member-name">
                  Everyone <span className="member-baseline-tag">Baseline</span>
                </span>
                <span className="member-sub">All users, including guests</span>
              </div>
              {isPublic ? (
                <RoleControl value={library.publicRole} disabled />
              ) : (
                <span className="member-noaccess">No access</span>
              )}
              <Button
                variant="icon"
                disabled
                title="Public access is set in the library's settings"
                aria-label="Public access is set in the library's settings"
              >
                <Lock size={14} />
              </Button>
            </div>
          </div>
        )}
      </section>

      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={saving}>Close</Button>
      </div>
    </Modal>
  );
}
