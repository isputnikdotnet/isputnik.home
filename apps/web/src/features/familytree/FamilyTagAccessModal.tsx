import { useCallback, useEffect, useState } from "react";
import { Tags } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { api } from "../../api";
import { MessageBox } from "../../shared/MessageBox";
import { AccessControl } from "../../shared/AccessControl";
import type { ManagedGroup, ManagedUser } from "../control/types";
import type { FamilyTag } from "./types";

// Admin surface for tag-scoped edit rights: pick a family tag, then grant
// users/groups the Editor role on it (assignments with object_type
// 'family_tree_tag' server-side). Mirrors LibraryMembersModal, with a reduced
// role vocabulary — viewing is open to all signed-in users anyway, so the only
// meaningful grants are "can edit" and an explicit block.
type EditorRole = "contributor" | "deny";

function roleOptions(t: TFunction<readonly ["common", "family"], undefined>): { value: EditorRole; label: string; tagline: string; dot: string }[] {
  return [
    { value: "contributor", label: t("family:tagAccess.roleEditor"), tagline: t("family:tagAccess.roleEditorTagline"), dot: "#14b8a6" },
    { value: "deny", label: t("family:tagAccess.roleBlocked"), tagline: t("family:tagAccess.roleBlockedTagline"), dot: "#ef4444" }
  ];
}

interface TagEditor {
  subjectType: "user" | "group";
  subjectId: string;
  role: EditorRole;
  name: string | null;
  email: string | null;
  missing: number;
}

// The branch-access body, rendered as the Security tab of the family-tree
// settings modal (it used to be a modal of its own).
export function FamilyTagAccessPanel() {
  const { t } = useTranslation(["common", "family"]);
  const [tags, setTags] = useState<FamilyTag[]>([]);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [groups, setGroups] = useState<ManagedGroup[]>([]);
  const [tagId, setTagId] = useState("");
  const [editors, setEditors] = useState<TagEditor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      api<{ tags: FamilyTag[] }>("/api/family-tree/tags"),
      api<{ users: ManagedUser[] }>("/api/users"),
      api<{ groups: ManagedGroup[] }>("/api/groups")
    ])
      .then(([tagPayload, userPayload, groupPayload]) => {
        setTags(tagPayload.tags);
        setUsers(userPayload.users);
        setGroups(groupPayload.groups);
        if (tagPayload.tags.length > 0) setTagId((prev) => prev || tagPayload.tags[0].id);
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("family:tagAccess.errors.loadTags")))
      .finally(() => setLoading(false));
  }, [t]);

  const loadEditors = useCallback(async (id: string) => {
    if (!id) {
      setEditors([]);
      return;
    }
    try {
      const payload = await api<{ editors: TagEditor[] }>(`/api/family-tree/tags/${id}/editors`);
      setEditors(payload.editors);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("family:tagAccess.errors.loadEditors"));
    }
  }, [t]);

  useEffect(() => {
    void loadEditors(tagId);
  }, [tagId, loadEditors]);

  const grant = async (subjectType: string, subjectId: string, nextRole: EditorRole) => {
    setSaving(true);
    setError("");
    try {
      await api(`/api/family-tree/tags/${tagId}/editors`, {
        method: "POST",
        body: JSON.stringify({ subjectType, subjectId, role: nextRole })
      });
      await loadEditors(tagId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("family:tagAccess.errors.saveGrant"));
    } finally {
      setSaving(false);
    }
  };

  const revoke = async (subjectType: string, subjectId: string) => {
    setSaving(true);
    setError("");
    try {
      await api(`/api/family-tree/tags/${tagId}/editors/${subjectType}/${subjectId}`, { method: "DELETE" });
      await loadEditors(tagId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("family:tagAccess.errors.revokeGrant"));
    } finally {
      setSaving(false);
    }
  };


  return (
    <div className="ft-access-panel">
      <p className="ft-modal-hint">
        {t("family:tagAccess.intro")}
      </p>

      {error && <MessageBox tone="error" title={t("family:tagAccess.unableToUpdate")}>{error}</MessageBox>}

      {loading ? (
        <p className="management-empty">{t("family:tagAccess.loading")}</p>
      ) : tags.length === 0 ? (
        <MessageBox tone="info" title={t("family:tagAccess.noTagsTitle")}>
          {t("family:tagAccess.noTagsBody")}
        </MessageBox>
      ) : (
        <>
          <div className="member-field member-field-grow">
            <Tags size={17} className="member-field-icon" aria-hidden="true" />
            <select value={tagId} onChange={(event) => setTagId(event.target.value)} aria-label={t("family:tagAccess.tagAria")}>
              {tags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name} — {t("family:common.counts.person", { count: tag.count })}
                </option>
              ))}
            </select>
          </div>

          <AccessControl
            roles={roleOptions(t)}
            members={editors.map((editor) => ({
              subjectType: editor.subjectType,
              subjectId: editor.subjectId,
              role: editor.role,
              name: editor.name ?? t("family:tagAccess.deletedLabel"),
              sub: editor.subjectType === "group" ? undefined : editor.email ?? undefined,
              missing: Boolean(editor.missing)
            }))}
            candidates={{
              users: users.map((user) => ({ id: user.id, name: `${user.displayName} (${user.email})` })),
              groups: groups.map((group) => ({ id: group.id, name: group.name }))
            }}
            busy={saving}
            emptyHint={t("family:tagAccess.noEditorsYet")}
            onGrant={(subjectType, subjectId, role) => void grant(subjectType, subjectId, role as EditorRole)}
            onRevoke={(subjectType, subjectId) => void revoke(subjectType, subjectId)}
          />
        </>
      )}

    </div>
  );
}
