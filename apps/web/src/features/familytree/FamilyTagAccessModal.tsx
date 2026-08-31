import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, Tags, Trash2, UserPlus, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
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

function RoleControl({
  value,
  disabled,
  onChange
}: {
  value: EditorRole;
  disabled?: boolean;
  onChange?: (role: EditorRole) => void;
}) {
  const { t } = useTranslation(["common", "family"]);
  const options = roleOptions(t);
  const meta = options.find((o) => o.value === value) ?? options[0];
  return (
    <div className={`member-role-control${disabled ? " is-locked" : ""}`}>
      <span className="member-role-dot" style={{ background: meta.dot }} aria-hidden="true" />
      <select
        value={value}
        disabled={disabled}
        onChange={onChange ? (event) => onChange(event.target.value as EditorRole) : undefined}
        aria-label={t("family:tagAccess.roleAria")}
      >
        {options.map((option) => (
          <option value={option.value} key={option.value}>{option.label} ({option.tagline})</option>
        ))}
      </select>
    </div>
  );
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
  const [subject, setSubject] = useState("");
  const [role, setRole] = useState<EditorRole>("contributor");
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

  const addGrant = async () => {
    if (!subject) return;
    const [subjectType, subjectId] = subject.split(":");
    await grant(subjectType, subjectId, role);
    setSubject("");
    setRole("contributor");
  };

  const revoke = async (editor: TagEditor) => {
    setSaving(true);
    setError("");
    try {
      await api(`/api/family-tree/tags/${tagId}/editors/${editor.subjectType}/${editor.subjectId}`, { method: "DELETE" });
      await loadEditors(tagId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("family:tagAccess.errors.revokeGrant"));
    } finally {
      setSaving(false);
    }
  };

  const activeTag = tags.find((tag) => tag.id === tagId) ?? null;
  const options = roleOptions(t);

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

          <section className="member-section">
            <h3 className="member-section-title">
              {activeTag ? t("family:tagAccess.grantTitleWithTag", { tag: activeTag.name }) : t("family:tagAccess.grantTitle")}
            </h3>
            <div className="member-grant">
              <div className="member-field member-field-grow">
                <Users size={17} className="member-field-icon" aria-hidden="true" />
                <select value={subject} onChange={(event) => setSubject(event.target.value)} aria-label={t("family:tagAccess.userOrGroupAria")}>
                  <option value="">{t("family:tagAccess.selectUserOrGroupOption")}</option>
                  {users.length > 0 && (
                    <optgroup label={t("family:tagAccess.usersGroupLabel")}>
                      {users.map((user) => (
                        <option value={`user:${user.id}`} key={`u-${user.id}`}>{user.displayName} ({user.email})</option>
                      ))}
                    </optgroup>
                  )}
                  {groups.length > 0 && (
                    <optgroup label={t("family:tagAccess.groupsGroupLabel")}>
                      {groups.map((group) => (
                        <option value={`group:${group.id}`} key={`g-${group.id}`}>{group.name}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </div>
              <div className="member-field">
                <ShieldCheck size={17} className="member-field-icon" aria-hidden="true" />
                <select value={role} onChange={(event) => setRole(event.target.value as EditorRole)} aria-label={t("family:tagAccess.roleToGrantAria")}>
                  {options.map((option) => (
                    <option value={option.value} key={option.value}>{option.label} ({option.tagline})</option>
                  ))}
                </select>
              </div>
              <Button variant="primary" onClick={() => void addGrant()} disabled={saving || !subject}>
                <UserPlus size={16} aria-hidden="true" />
                <span>{t("family:tagAccess.addButton")}</span>
              </Button>
            </div>
          </section>

          <section className="member-section">
            <h3 className="member-section-title">{t("family:tagAccess.editorsSectionTitle")}</h3>
            <div className="member-rows">
              {editors.map((editor) => {
                const isGroup = editor.subjectType === "group";
                const label = editor.name ?? t("family:tagAccess.deletedLabel");
                return (
                  <div className="member-row" key={`${editor.subjectType}:${editor.subjectId}`}>
                    <span className="member-avatar member-avatar-neutral" aria-hidden="true">
                      <Users size={18} />
                    </span>
                    <div className="member-identity">
                      <span className="member-name">{label}{editor.missing ? ` ${t("family:tagAccess.deletedLabel")}` : ""}</span>
                      <span className="member-sub">{isGroup ? t("family:tagAccess.groupLabel") : (editor.email ?? t("family:tagAccess.userLabel"))}</span>
                    </div>
                    <RoleControl
                      value={editor.role}
                      disabled={saving || Boolean(editor.missing)}
                      onChange={(next) => { if (next !== editor.role) void grant(editor.subjectType, editor.subjectId, next); }}
                    />
                    <Button
                      variant="icon"
                      danger
                      title={t("family:tagAccess.removeAria", { name: label })}
                      aria-label={t("family:tagAccess.removeAria", { name: label })}
                      onClick={() => void revoke(editor)}
                      disabled={saving}
                    >
                      <Trash2 size={15} />
                    </Button>
                  </div>
                );
              })}
              {editors.length === 0 && (
                <p className="member-empty">{t("family:tagAccess.noEditorsYet")}</p>
              )}
            </div>
          </section>
        </>
      )}

    </div>
  );
}
