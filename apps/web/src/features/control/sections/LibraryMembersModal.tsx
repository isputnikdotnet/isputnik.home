import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Globe2, Lock } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import { AccessControl } from "../../../shared/AccessControl";
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

  // Roles upsert server-side (POST with a new role replaces it), so one call
  // covers both adding somebody and changing what they may do.
  const addGrant = async (subjectType: string, subjectId: string, role: LibraryRole) => {
    setSaving(true);
    setError("");
    try {
      await api(`/api/library/libraries/${library.id}/members`, {
        method: "POST",
        body: JSON.stringify({ subjectType, subjectId, role })
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("control:libraryMembers.unableToGrant"));
    } finally {
      setSaving(false);
    }
  };

  const revoke = async (subjectType: string, subjectId: string) => {
    setSaving(true);
    setError("");
    try {
      await api(`/api/library/libraries/${library.id}/members/${subjectType}/${subjectId}`, {
        method: "DELETE"
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("control:libraryMembers.unableToRevoke"));
    } finally {
      setSaving(false);
    }
  };

  const roles = LIBRARY_ROLE_OPTIONS.map((option) => ({
    value: option.value,
    label: roleName(option.value),
    tagline: roleTagline(option.value),
    dot: ROLE_DOT[option.value]
  }));

  // A group says how many people it carries; a person says their email.
  const memberSub = (member: LibraryMember) => {
    if (member.subjectType !== "group") return member.email ?? t("control:libraryMembers.user");
    const count = groups.find((group) => group.id === member.subjectId)?.memberCount;
    return count != null ? t("control:libraryMembers.groupMemberCount", { count }) : t("control:libraryMembers.group");
  };

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

      {error && <MessageBox tone="error" title={t("control:libraryMembers.errorTitle")}>{error}</MessageBox>}

      {loading ? (
        <p className="management-empty">{t("control:libraryMembers.loadingMembers")}</p>
      ) : (
        <AccessControl
          roles={roles}
          defaultRole="member"
          members={members.map((member) => ({
            subjectType: member.subjectType,
            subjectId: member.subjectId,
            role: member.role,
            name: member.name,
            sub: memberSub(member),
            missing: Boolean(member.missing)
          }))}
          candidates={{
            users: users.map((user) => ({ id: user.id, name: user.displayName + " (" + user.email + ")" })),
            groups: groups.map((group) => ({ id: group.id, name: group.name }))
          }}
          everyone={{
            // A library's baseline is set on the library itself, so it is
            // shown here and changed there.
            role: isPublic ? library.publicRole : null,
            hint: t("control:libraryMembers.everyoneSub"),
            lockedHint: t("control:libraryMembers.publicSetInLibraryTitle")
          }}
          busy={saving}
          emptyHint={t("control:libraryMembers.noMembersYet")}
          onGrant={(subjectType, subjectId, role) => void addGrant(subjectType, subjectId, role as LibraryRole)}
          onRevoke={(subjectType, subjectId) => void revoke(subjectType, subjectId)}
        />
      )}

      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={saving}>{t("control:ui.close")}</Button>
      </div>
    </Modal>
  );
}
