import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Globe2, Lock, ShieldCheck, Trash2, UserPlus, Users } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import { LIBRARY_ROLE_OPTIONS, type LibraryMember, type LibraryRole, type PublicRole } from "../../audiobooks/types";
import type { ManagedUser, ManagedGroup } from "../types";
// Plain lookup functions rather than module-level consts, so a language switch
// is picked up (docs/i18n-plan.md's namespace-key typing pitfall #3).
import i18n from "../../../i18n";

// Per-role colour dot + short tagline + display name shown in the role dropdowns.
// The name is looked up here rather than taken from the shared LIBRARY_ROLE_OPTIONS
// (used elsewhere, out of this batch's scope and still English) so the dropdowns
// read in the active language without touching that shared constant.
const ROLE_DOT: Record<LibraryRole, string> = {
  viewer: "#3b82f6",
  member: "#8b5cf6",
  contributor: "#14b8a6",
  manager: "#f59e0b",
  deny: "#ef4444"
};

function roleName(role: LibraryRole): string {
  return i18n.t(`control:libraries.role.${role}`);
}

function roleTagline(role: LibraryRole): string {
  switch (role) {
    case "viewer": return i18n.t("control:libraryMembers.viewerTagline");
    case "member": return i18n.t("control:libraryMembers.memberTagline");
    case "contributor": return i18n.t("control:libraryMembers.contributorTagline");
    case "manager": return i18n.t("control:libraryMembers.managerTagline");
    case "deny": return i18n.t("control:libraryMembers.denyTagline");
  }
}

function publicDescription(role: PublicRole): string {
  switch (role) {
    case "viewer": return i18n.t("control:libraryMembers.publicViewer");
    case "member": return i18n.t("control:libraryMembers.publicMember");
    case "contributor": return i18n.t("control:libraryMembers.publicContributor");
  }
}

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
  const { t } = useTranslation(["common", "control"]);
  return (
    <div className={`member-role-control${disabled ? " is-locked" : ""}`}>
      <span className="member-role-dot" style={{ background: ROLE_DOT[value] }} aria-hidden="true" />
      <select
        value={value}
        disabled={disabled}
        onChange={onChange ? (event) => onChange(event.target.value as LibraryRole) : undefined}
        aria-label={t("control:libraryMembers.roleAria")}
      >
        {LIBRARY_ROLE_OPTIONS.map((option) => (
          <option value={option.value} key={option.value}>{roleName(option.value)} ({roleTagline(option.value)})</option>
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
  const { t } = useTranslation(["common", "control"]);
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
      setError(err instanceof Error ? err.message : t("control:libraryMembers.unableToLoad"));
    } finally {
      setLoading(false);
    }
  }, [library.id, t]);

  useEffect(() => {
    load();
  }, [load]);

  const addGrant = async () => {
    if (!subject) {
      setError(t("control:libraryMembers.chooseSubject"));
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
      setError(err instanceof Error ? err.message : t("control:libraryMembers.unableToGrant"));
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
      setError(err instanceof Error ? err.message : t("control:libraryMembers.unableToUpdateRole"));
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
      setError(err instanceof Error ? err.message : t("control:libraryMembers.unableToRevoke"));
    } finally {
      setSaving(false);
    }
  };

  const groupMemberCount = (id: string) => groups.find((group) => group.id === id)?.memberCount;

  return (
    <Modal
      title={t("control:libraryMembers.title", { name: library.name })}
      className="library-members-modal"
      busy={saving}
      onClose={onClose}
    >
      <div className={`member-banner ${isPublic ? "is-public" : "is-private"}`}>
        <span className="member-banner-icon" aria-hidden="true">
          {isPublic ? <Globe2 size={22} /> : <Lock size={20} />}
        </span>
        <div className="member-banner-copy">
          <strong>{isPublic ? t("control:libraryMembers.publicTrue") : t("control:libraryMembers.publicFalse")}</strong>
          <span>
            {isPublic
              ? publicDescription(library.publicRole) ?? t("control:libraryMembers.publicFallback")
              : t("control:libraryMembers.privateBody")}
          </span>
        </div>
        <span className="member-banner-pill">{isPublic ? t("control:libraryMembers.publicAccess") : t("control:libraryMembers.private")}</span>
      </div>

      <section className="member-section">
        <h3 className="member-section-title">{t("control:libraryMembers.grantAccess")}</h3>
        <div className="member-grant">
          <div className="member-field member-field-grow">
            <Users size={17} className="member-field-icon" aria-hidden="true" />
            <select value={subject} onChange={(event) => setSubject(event.target.value)} aria-label={t("control:libraryMembers.userOrGroupAria")}>
              <option value="">{t("control:libraryMembers.selectUserOrGroup")}</option>
              {users.length > 0 && (
                <optgroup label={t("control:libraryMembers.optgroupUsers")}>
                  {users.map((user) => (
                    <option value={`user:${user.id}`} key={`u-${user.id}`}>{user.displayName} ({user.email})</option>
                  ))}
                </optgroup>
              )}
              {groups.length > 0 && (
                <optgroup label={t("control:libraryMembers.optgroupGroups")}>
                  {groups.map((group) => (
                    <option value={`group:${group.id}`} key={`g-${group.id}`}>{group.name}</option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>
          <div className="member-field">
            <ShieldCheck size={17} className="member-field-icon" aria-hidden="true" />
            <select value={role} onChange={(event) => setRole(event.target.value as LibraryRole)} aria-label={t("control:libraryMembers.roleToGrantAria")}>
              {LIBRARY_ROLE_OPTIONS.map((option) => (
                <option value={option.value} key={option.value}>{roleName(option.value)} ({roleTagline(option.value)})</option>
              ))}
            </select>
          </div>
          <Button variant="primary" onClick={addGrant} disabled={saving || !subject}>
            <UserPlus size={16} aria-hidden="true" />
            <span>{t("control:libraryMembers.add")}</span>
          </Button>
        </div>
      </section>

      {error && <MessageBox tone="error" title={t("control:libraryMembers.errorTitle")}>{error}</MessageBox>}

      <section className="member-section">
        <h3 className="member-section-title">{t("control:libraryMembers.membersWithAccess")}</h3>
        {loading ? (
          <p className="management-empty">{t("control:libraryMembers.loadingMembers")}</p>
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
                    <span className="member-name">{member.name}{member.missing ? t("control:libraryMembers.deletedSuffix") : ""}</span>
                    <span className="member-sub">
                      {isGroup
                        ? (count != null ? t("control:libraryMembers.groupMemberCount", { count }) : t("control:libraryMembers.group"))
                        : (member.email ?? t("control:libraryMembers.user"))}
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
                    title={t("control:libraryMembers.removeAria", { name: member.name })}
                    aria-label={t("control:libraryMembers.removeAria", { name: member.name })}
                    onClick={() => revoke(member)}
                    disabled={saving}
                  >
                    <Trash2 size={15} />
                  </Button>
                </div>
              );
            })}

            {members.length === 0 && (
              <p className="member-empty">{t("control:libraryMembers.noMembersYet")}</p>
            )}

            <div className="member-row member-row-everyone">
              <span className="member-avatar member-avatar-neutral" aria-hidden="true"><Globe2 size={18} /></span>
              <div className="member-identity">
                <span className="member-name">
                  {t("control:libraryMembers.everyone")} <span className="member-baseline-tag">{t("control:libraryMembers.baseline")}</span>
                </span>
                <span className="member-sub">{t("control:libraryMembers.everyoneSub")}</span>
              </div>
              {isPublic ? (
                <RoleControl value={library.publicRole} disabled />
              ) : (
                <span className="member-noaccess">{t("control:libraryMembers.noAccess")}</span>
              )}
              <Button
                variant="icon"
                disabled
                title={t("control:libraryMembers.publicSetInLibraryTitle")}
                aria-label={t("control:libraryMembers.publicSetInLibraryTitle")}
              >
                <Lock size={14} />
              </Button>
            </div>
          </div>
        )}
      </section>

      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={saving}>{t("control:ui.close")}</Button>
      </div>
    </Modal>
  );
}
