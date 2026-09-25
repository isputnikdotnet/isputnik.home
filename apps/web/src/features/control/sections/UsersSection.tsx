import { useState, useEffect, useCallback, useMemo, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Plus, Search, Shield, User, Users } from "lucide-react";
import i18n from "../../../i18n";
import { api, type PublicUser } from "../../../api";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { SelectField } from "../../../shared/SelectField";
import { Button } from "../../../shared/Button";
import { ActionMenu } from "../../../shared/ActionMenu";
import { RefreshButton } from "../../../shared/RefreshButton";
import { formatManagedDate } from "../../../shared/utils";
import type { ManagedUser } from "../types";
import { ControlSectionHead } from "../ControlSectionHead";
import { memberHref, navigate, type MemberPageTab } from "../../../router";
import { initialParam, userAccessHref } from "../links";
import { useUserActions } from "../members/useUserActions";

type UserRole = "admin" | "member";

function roleLabel(role: UserRole): string {
  return role === "admin" ? i18n.t("controlAdmin:users.roleAdmin") : i18n.t("controlAdmin:users.roleMember");
}

function formatSessionCount(value: number) {
  return i18n.t("controlAdmin:ui.sessions", { count: value });
}

/** Whole minutes until an ISO instant, floored at zero. Read off a badge, so a
 *  rounded number beats a ticking clock — the list is not a countdown timer. */
function minutesLeft(iso: string): number {
  return Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60_000));
}

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

  // Password, two-factor, passkeys, remote linking, lockout, delete: the same
  // menu and dialogs a member's page has (members/useUserActions).
  const actions = useUserActions({ currentUserId: currentUser.id, onChanged: loadUsers, onError: setError });

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

  // Everything about one person is its own page (members/MemberPage).
  const openMember = (account: ManagedUser, tab: MemberPageTab = "account") => navigate(memberHref(account.id, tab));

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
          <Button variant="primary" onClick={openCreate} title={t("controlAdmin:users.newUser")}>
            <Plus size={18} />
            <span>{t("controlAdmin:users.newUser")}</span>
          </Button>
        </div>
      </ControlSectionHead>

      {error && <MessageBox tone="error" title={t("controlAdmin:users.errorTitle")}>{error}</MessageBox>}
      {notice && <MessageBox tone="info" title={t("controlAdmin:users.reusedTitle")}>{notice}</MessageBox>}

      <div className="user-controls-bar">
        <label className="search-field user-search">
          <Search size={17} aria-hidden="true" />
          <span className="sr-only">{t("controlAdmin:users.searchUsers")}</span>
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t("controlAdmin:users.searchPlaceholder")}
          />
        </label>
      </div>

      {visibleUsers.length === 0 ? (
        <p className="management-empty">
          {users.length === 0 ? t("controlAdmin:users.noUsers") : t("controlAdmin:users.noMatch")}
        </p>
      ) : (
        <div className="datagrid-wrap">
          <table className="datagrid user-table">
            <thead>
              <tr>
                <th>{t("controlAdmin:users.thUser")}</th>
                <th>{t("controlAdmin:users.thRole")}</th>
                <th className="col-num">{t("controlAdmin:users.thSessions")}</th>
                <th>{t("controlAdmin:users.thCreated")}</th>
                {/* The word is wider than the column now that the column holds one
                    ⋮ button, and in a fixed-layout table a heading that doesn't fit
                    puts the whole grid into a horizontal scroll. Kept for screen
                    readers, which is the only audience it was serving anyway. */}
                <th className="col-actions"><span className="sr-only">{t("controlAdmin:users.thActions")}</span></th>
              </tr>
            </thead>
            <tbody>
              {visibleUsers.map((account) => {
                const isCurrent = account.id === currentUser.id;
                return (
                  <tr key={account.id}>
                    <td>
                      <div className="user-account-cell">
                        <span className="user-avatar-icon" aria-hidden="true">
                          <User size={20} />
                        </span>
                        <div className="datagrid-primary">
                          <span className="user-name-line">
                            <Button variant="text" className="user-name-link" onClick={() => openMember(account)}>
                              <strong>{account.displayName}</strong>
                            </Button>
                            {isCurrent && <span className="status-badge current">{t("controlAdmin:users.badgeCurrent")}</span>}
                            {account.protectedFromDelete && <span className="status-badge protected">{t("controlAdmin:users.badgeProtected")}</span>}
                            {account.locked && <span className="status-badge locked">{t("controlAdmin:users.badgeLocked")}</span>}
                            {/* Only ever visible for the hour it is open, which is
                                the whole design: there is no lasting state here to
                                forget about. */}
                            {account.deviceLinkWindowExpiresAt && (
                              <span className="status-badge device-window">
                                {t("controlAdmin:users.remoteLinking", { count: minutesLeft(account.deviceLinkWindowExpiresAt) })}
                              </span>
                            )}
                          </span>
                          <small>{account.email}</small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={`status-badge ${account.role}`}>{roleLabel(account.role)}</span>
                    </td>
                    <td className="col-num datagrid-muted">{formatSessionCount(account.activeSessions)}</td>
                    <td className="datagrid-muted">{formatManagedDate(account.createdAt)}</td>
                    <td className="col-actions">
                      {/* One menu rather than seven icon buttons. Everything here is
                          occasional — nothing is reached for often enough to earn a
                          permanent square — and as icons their meaning lived in
                          tooltips. In the menu each one gets its name back, and the
                          reason an unavailable action is unavailable is its tooltip
                          rather than a mystery grey glyph. */}
                      <div className="row-actions">
                        <ActionMenu
                          trigger="icon"
                          label={t("controlAdmin:users.manageAria", { name: account.displayName })}
                          items={[
                            {
                              key: "edit",
                              label: t("controlAdmin:users.editUser"),
                              icon: <Pencil size={15} />,
                              onSelect: () => openMember(account)
                            },
                            ...actions.menuItems(account)
                          ]}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

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

      {actions.dialogs}
    </>
  );
}
