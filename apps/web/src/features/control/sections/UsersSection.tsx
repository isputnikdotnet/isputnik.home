import { useState, useEffect, useCallback, useMemo, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Shield, Users } from "lucide-react";
import i18n from "../../../i18n";
import { api, type PublicUser } from "../../../api";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { SelectField } from "../../../shared/SelectField";
import { Button } from "../../../shared/Button";
import { AddRow, GroupedList, GroupedSearch, NavRow, initials } from "../../../shared/GroupedList";
import { RefreshButton } from "../../../shared/RefreshButton";
import type { ManagedUser } from "../types";
import { ControlSectionHead } from "../ControlSectionHead";
import { memberHref, navigate } from "../../../router";
import { initialParam, userAccessHref } from "../links";

type UserRole = "admin" | "member";

function roleLabel(role: UserRole): string {
  return role === "admin" ? i18n.t("controlAdmin:users.roleAdmin") : i18n.t("controlAdmin:users.roleMember");
}

/** Whole minutes until an ISO instant, floored at zero. Read off a badge, so a
 *  rounded number beats a ticking clock — the list is not a countdown timer. */
function minutesLeft(iso: string): number {
  return Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60_000));
}

// Members › Users, laid out like a phone's contacts (control panel v2): a search
// field over the people as rows — initials, name and marks, address, role — each
// opening the member's page, which holds everything that can be done to them.
export function UsersSection({ currentUser }: { currentUser: PublicUser }) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [modalError, setModalError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  // The Access dialog used to open over this list from ?user=&tab=; those links
  // (bookmarks, the preview banner's Stop) land on the member's page instead.
  useEffect(() => {
    const id = initialParam("user");
    if (id) navigate(userAccessHref(id, initialParam("tab") || undefined));
  }, []);

  const [createOpen, setCreateOpen] = useState(false);
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<UserRole>("member");
  const [creating, setCreating] = useState(false);

  const loadUsers = useCallback(async () => {
    const payload = await api<{ users: ManagedUser[] }>("/api/users");
    setUsers(payload.users);
  }, []);

  useEffect(() => {
    loadUsers().catch((err) => setError(err instanceof Error ? err.message : t("controlAdmin:users.loadFailed")));
  }, [loadUsers, t]);

  const visibleUsers = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return users;
    return users.filter((account) => [
      account.displayName,
      account.email,
      roleLabel(account.role),
      account.protectedFromDelete ? "protected" : "",
      account.id === currentUser.id ? "current" : ""
    ].some((value) => value.toLowerCase().includes(query)));
  }, [currentUser.id, searchQuery, users]);

  const openCreate = () => {
    setError("");
    setNotice("");
    setModalError("");
    setNewDisplayName("");
    setNewEmail("");
    setNewPassword("");
    setNewRole("member");
    setCreateOpen(true);
  };

  const createUser = async (event: FormEvent) => {
    event.preventDefault();
    setCreating(true);
    setModalError("");
    try {
      const result = await api<{ restored?: boolean }>("/api/users", {
        method: "POST",
        body: JSON.stringify({
          displayName: newDisplayName,
          email: newEmail,
          password: newPassword,
          role: newRole
        })
      });
      // The address belonged to a deleted account, so this took that account's place
      // rather than making a second one. Say so — what came back with it is not
      // obvious, and the admin is the one who has to tell the new user.
      setNotice(
        result.restored
          ? t("controlAdmin:users.restoredNotice", { name: newDisplayName })
          : ""
      );
      setCreateOpen(false);
      await loadUsers();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : t("controlAdmin:users.createFailed"));
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <ControlSectionHead
        section="users"
        icon={<Users size={30} />}
        iconClassName="blue"
        description={t("controlAdmin:users.headDescription")}
      >
        <div className="row-actions">
          <RefreshButton
            onRefresh={async () => {
              setError("");
              try {
                await loadUsers();
              } catch (err) {
                setError(err instanceof Error ? err.message : t("controlAdmin:users.refreshFailed"));
                throw err;
              }
            }}
          />
        </div>
      </ControlSectionHead>

      {error && <MessageBox tone="error" title={t("controlAdmin:users.errorTitle")}>{error}</MessageBox>}
      {notice && <MessageBox tone="info" title={t("controlAdmin:users.reusedTitle")}>{notice}</MessageBox>}

      <div className="grouped-page">
        <GroupedSearch value={searchQuery} onChange={setSearchQuery} label={t("controlAdmin:users.searchUsers")} placeholder={t("controlAdmin:users.searchPlaceholder")} />
        <GroupedList note={visibleUsers.length === 0 ? (users.length === 0 ? t("controlAdmin:users.noUsers") : t("controlAdmin:users.noMatch")) : undefined}>
          {visibleUsers.map((account) => {
            const isCurrent = account.id === currentUser.id;
            const badges = [
              isCurrent && <span key="current" className="status-badge current">{t("controlAdmin:users.badgeCurrent")}</span>,
              account.protectedFromDelete && <span key="protected" className="status-badge protected">{t("controlAdmin:users.badgeProtected")}</span>,
              account.locked && <span key="locked" className="status-badge locked">{t("controlAdmin:users.badgeLocked")}</span>,
              // Only ever visible for the hour it is open, which is the whole
              // design: there is no lasting state here to forget about.
              account.deviceLinkWindowExpiresAt && (
                <span key="window" className="status-badge device-window">
                  {t("controlAdmin:users.remoteLinking", { count: minutesLeft(account.deviceLinkWindowExpiresAt) })}
                </span>
              )
            ].filter(Boolean);
            return (
              <NavRow
                key={account.id}
                icon={initials(account.displayName)}
                iconShape="round"
                iconTone={account.locked ? "danger" : undefined}
                label={<>{account.displayName}{badges.length > 0 && <span className="grouped-badges">{badges}</span>}</>}
                sub={account.email}
                value={roleLabel(account.role)}
                href={memberHref(account.id, "account")}
              />
            );
          })}
          {!searchQuery.trim() && (
            <AddRow icon={<Plus size={17} />} label={t("controlAdmin:users.newUser")} onClick={openCreate} />
          )}
        </GroupedList>
      </div>

      {createOpen && (
        <Modal
          title={t("controlAdmin:users.createUser")}
          className="user-form-modal"
          busy={creating}
          onClose={() => setCreateOpen(false)}
          onSubmit={createUser}
        >
          <Field label={t("controlAdmin:users.displayName")} value={newDisplayName} onChange={setNewDisplayName} autoComplete="name" />
          <Field label={t("common.email")} type="email" value={newEmail} onChange={setNewEmail} autoComplete="email" />
          <Field
            label={t("common.password")}
            type="password"
            minLength={8}
            value={newPassword}
            onChange={setNewPassword}
            autoComplete="new-password"
          />
          <SelectField
            label={t("controlAdmin:users.role")}
            icon={<Shield size={17} />}
            value={newRole}
            onChange={(value) => setNewRole(value as UserRole)}
            options={[
              { value: "member", label: t("controlAdmin:users.roleMember") },
              { value: "admin", label: t("controlAdmin:users.roleAdmin") }
            ]}
          />
          {modalError && <MessageBox tone="error" title={t("controlAdmin:users.createFailed")}>{modalError}</MessageBox>}
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={creating} autoFocus>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={creating || !newDisplayName.trim() || !newEmail.trim() || newPassword.length < 8}
            >
              {creating ? t("controlAdmin:users.creating") : t("controlAdmin:users.createUser")}
            </Button>
          </div>
        </Modal>
      )}

    </>
  );
}
