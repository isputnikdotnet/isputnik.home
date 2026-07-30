import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, Tags, Trash2, UserPlus, Users } from "lucide-react";
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

const ROLE_OPTIONS: { value: EditorRole; label: string; tagline: string; dot: string }[] = [
  { value: "contributor", label: "Editor", tagline: "Edit tagged people + add relatives", dot: "#14b8a6" },
  { value: "deny", label: "Blocked", tagline: "No edit access, overrides grants", dot: "#ef4444" }
];

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
  const meta = ROLE_OPTIONS.find((o) => o.value === value) ?? ROLE_OPTIONS[0];
  return (
    <div className={`member-role-control${disabled ? " is-locked" : ""}`}>
      <span className="member-role-dot" style={{ background: meta.dot }} aria-hidden="true" />
      <select
        value={value}
        disabled={disabled}
        onChange={onChange ? (event) => onChange(event.target.value as EditorRole) : undefined}
        aria-label="Role"
      >
        {ROLE_OPTIONS.map((option) => (
          <option value={option.value} key={option.value}>{option.label} ({option.tagline})</option>
        ))}
      </select>
    </div>
  );
}

// The branch-access body, rendered as the Security tab of the family-tree
// settings modal (it used to be a modal of its own).
export function FamilyTagAccessPanel() {
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
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load family tags"))
      .finally(() => setLoading(false));
  }, []);

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
      setError(err instanceof Error ? err.message : "Unable to load editors");
    }
  }, []);

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
      setError(err instanceof Error ? err.message : "Unable to save the grant");
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
      setError(err instanceof Error ? err.message : "Unable to revoke the grant");
    } finally {
      setSaving(false);
    }
  };

  const activeTag = tags.find((t) => t.id === tagId) ?? null;

  return (
    <div className="ft-access-panel">
      <p className="ft-modal-hint">
        Family tags group people into branches. Granting the Editor role on a tag lets a user or group edit
        every person carrying that tag and add relatives to them. Assign tags to people via Edit person (admins only).
      </p>

      {error && <MessageBox tone="error" title="Unable to update branch access">{error}</MessageBox>}

      {loading ? (
        <p className="management-empty">Loading…</p>
      ) : tags.length === 0 ? (
        <MessageBox tone="info" title="No family tags yet">
          Tag people first (Edit person → Family tags), then grant edit rights on those tags here.
        </MessageBox>
      ) : (
        <>
          <div className="member-field member-field-grow">
            <Tags size={17} className="member-field-icon" aria-hidden="true" />
            <select value={tagId} onChange={(event) => setTagId(event.target.value)} aria-label="Family tag">
              {tags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name} — {tag.count} {tag.count === 1 ? "person" : "people"}
                </option>
              ))}
            </select>
          </div>

          <section className="member-section">
            <h3 className="member-section-title">Grant edit rights{activeTag ? ` — ${activeTag.name}` : ""}</h3>
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
                <select value={role} onChange={(event) => setRole(event.target.value as EditorRole)} aria-label="Role to grant">
                  {ROLE_OPTIONS.map((option) => (
                    <option value={option.value} key={option.value}>{option.label} ({option.tagline})</option>
                  ))}
                </select>
              </div>
              <Button variant="primary" onClick={() => void addGrant()} disabled={saving || !subject}>
                <UserPlus size={16} aria-hidden="true" />
                <span>Add</span>
              </Button>
            </div>
          </section>

          <section className="member-section">
            <h3 className="member-section-title">Editors</h3>
            <div className="member-rows">
              {editors.map((editor) => {
                const isGroup = editor.subjectType === "group";
                const label = editor.name ?? "(deleted)";
                return (
                  <div className="member-row" key={`${editor.subjectType}:${editor.subjectId}`}>
                    <span className="member-avatar member-avatar-neutral" aria-hidden="true">
                      <Users size={18} />
                    </span>
                    <div className="member-identity">
                      <span className="member-name">{label}{editor.missing ? " (deleted)" : ""}</span>
                      <span className="member-sub">{isGroup ? "Group" : (editor.email ?? "User")}</span>
                    </div>
                    <RoleControl
                      value={editor.role}
                      disabled={saving || Boolean(editor.missing)}
                      onChange={(next) => { if (next !== editor.role) void grant(editor.subjectType, editor.subjectId, next); }}
                    />
                    <Button
                      variant="icon"
                      danger
                      title={`Remove ${label}`}
                      aria-label={`Remove ${label}`}
                      onClick={() => void revoke(editor)}
                      disabled={saving}
                    >
                      <Trash2 size={15} />
                    </Button>
                  </div>
                );
              })}
              {editors.length === 0 && (
                <p className="member-empty">No editors yet — only admins can edit this branch.</p>
              )}
            </div>
          </section>
        </>
      )}

    </div>
  );
}
