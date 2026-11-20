import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../api";
import { AccessControl } from "../../../shared/AccessControl";
import { MessageBox } from "../../../shared/MessageBox";
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

type MembersLibrary = { id: string; name: string; visibility: "public" | "private"; publicRole: PublicRole };

/** A library's grants: read, given and taken back at once (not by the Edit popup's Save). */
function useLibraryMembers(libraryId: string) {
  const { t } = useTranslation(["common", "control"]);
  const [members, setMembers] = useState<LibraryMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await api<{ members: LibraryMember[] }>(`/api/library/libraries/${libraryId}/members`);
      setMembers(payload.members);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("control:libraryMembers.unableToLoad"));
    } finally {
      setLoading(false);
    }
  }, [libraryId, t]);

  useEffect(() => {
    load();
  }, [load]);

  // Roles upsert server-side (POST with a new role replaces it), so one call
  // covers both adding somebody and changing what they may do.
  const addGrant = async (subjectType: string, subjectId: string, role: LibraryRole) => {
    setSaving(true);
    setError("");
    try {
      await api(`/api/library/libraries/${libraryId}/members`, {
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
      await api(`/api/library/libraries/${libraryId}/members/${subjectType}/${subjectId}`, {
        method: "DELETE"
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("control:libraryMembers.unableToRevoke"));
    } finally {
      setSaving(false);
    }
  };

  return { members, loading, error, saving, addGrant, revoke };
}

/** The list of a library's members and groups with Add: the shared AccessControl. */
function MembersControl({ library, users, groups, state }: {
  library: MembersLibrary;
  users: ManagedUser[];
  groups: ManagedGroup[];
  state: ReturnType<typeof useLibraryMembers>;
}) {
  const { t } = useTranslation(["common", "control"]);
  const isPublic = library.visibility === "public";
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
  if (state.loading) return <p className="management-empty">{t("control:libraryMembers.loadingMembers")}</p>;
  return (
    <AccessControl
      roles={roles}
      defaultRole="member"
      members={state.members.map((member) => ({
        subjectType: member.subjectType,
        subjectId: member.subjectId,
        role: member.role,
        name: member.name,
        sub: memberSub(member),
        missing: Boolean(member.missing)
      }))}
      candidates={{
        users: users.map((user) => ({ id: user.id, name: user.displayName, sub: user.email })),
        groups: groups.map((group) => ({ id: group.id, name: group.name, sub: t("control:libraryMembers.groupMemberCount", { count: group.memberCount ?? 0 }) }))
      }}
      everyone={{
        // A library's baseline is set on the library itself, so it is
        // shown here and changed there.
        role: isPublic ? library.publicRole : null,
        hint: t("control:libraryMembers.everyoneSub"),
        lockedHint: t("control:libraryMembers.publicSetInLibraryTitle")
      }}
      busy={state.saving}
      emptyHint={t("control:libraryMembers.noMembersYet")}
      onGrant={(subjectType, subjectId, role) => state.addGrant(subjectType, subjectId, role as LibraryRole)}
      onRevoke={(subjectType, subjectId) => void state.revoke(subjectType, subjectId)}
    />
  );
}

/** The same editor inside a page or popup (the library Edit popup's Name and
 *  access step, 2026-11-19): what public or private means for it, then the list. */
export function LibraryMembersEditor({ library, users, groups }: { library: MembersLibrary; users: ManagedUser[]; groups: ManagedGroup[] }) {
  const { t } = useTranslation(["common", "control"]);
  const state = useLibraryMembers(library.id);
  return (
    <div className="library-members-editor">
      <p className="muted">{library.visibility === "public"
        ? publicDescription(library.publicRole) ?? t("control:libraryMembers.publicFallback")
        : t("control:libraryMembers.privateBody")}</p>
      {state.error && <MessageBox tone="error" title={t("control:libraryMembers.errorTitle")}>{state.error}</MessageBox>}
      <MembersControl library={library} users={users} groups={groups} state={state} />
    </div>
  );
}
