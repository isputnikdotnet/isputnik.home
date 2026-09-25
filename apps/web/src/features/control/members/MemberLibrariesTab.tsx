import { useTranslation } from "react-i18next";
import { Inbox, LibraryBig } from "lucide-react";
import { api } from "../../../api";
import { SelectField } from "../../../shared/SelectField";
import { inboxLevel, useGrantWords, type AccessSubjectState } from "../access/AccessTabs";
import type { GrantRole, GrantView } from "../access/types";

// The Libraries tab of a member's page: one table, a row per library — what they
// end up with and where it comes from, then the choice made for them by name.
// The Photo Inbox is a card of its own: reviewing is a different kind of access
// from reading, and it has its own levels.

const LIBRARY_ROLES: GrantRole[] = ["viewer", "member", "contributor", "manager", "deny"];

export function MemberLibrariesTab({ state, name }: { state: AccessSubjectState; name: string }) {
  const { t } = useTranslation(["controlAdmin"]);
  const { overview, busy, write, base, body, del } = state;
  const { libraryRole, noDirectLabel } = useGrantWords(true);
  if (!overview) return null;

  // The role they have, and its source, as two lines rather than one sentence.
  const access = (view: GrantView): { role: string; source: string; none: boolean } => {
    if (view.effective == null) {
      const blocked = view.direct === "deny" || view.inherited.some((g) => g.role === "deny");
      return { role: blocked ? t("controlAdmin:access.blocked") : t("controlAdmin:access.none"), source: "", none: true };
    }
    const role = libraryRole(view.effective);
    if (view.direct === view.effective) return { role, source: t("controlAdmin:member.libraries.givenDirectly"), none: false };
    const from = view.inherited.find((g) => g.role === view.effective);
    if (from?.via === "group") return { role, source: t("controlAdmin:access.fromGroup", { group: from.groupName ?? "" }), none: false };
    if (from?.via === "everyone") return { role, source: t("controlAdmin:member.libraries.fromHousehold"), none: false };
    return { role, source: "", none: false };
  };

  return (
    <>
      <section className="member-card" aria-labelledby="member-libraries-title">
        <h2 id="member-libraries-title">
          <LibraryBig size={17} aria-hidden="true" />
          {t("controlAdmin:access.tabs.libraries")}
        </h2>
        <p className="access-muted">{t("controlAdmin:member.libraries.intro", { name })}</p>
        <table className="member-table member-libraries">
          <thead>
            <tr>
              <th>{t("controlAdmin:member.libraries.colLibrary")}</th>
              <th>{t("controlAdmin:member.libraries.colAccess")}</th>
              <th>{t("controlAdmin:member.libraries.colDirect")}</th>
            </tr>
          </thead>
          <tbody>
            {overview.libraries.map((library) => {
              const has = access(library);
              return (
                <tr key={library.id}>
                  <td>
                    <span className="member-table-primary">
                      <strong>{library.name}</strong>
                      <small>{t(`controlAdmin:access.libraryTypes.${library.type as "audiobook"}`, { defaultValue: library.type })}</small>
                    </span>
                  </td>
                  <td>
                    <span className="member-table-primary">
                      {has.none
                        ? <span className="access-muted">{has.role}</span>
                        : <span className="status-badge active">{has.role}</span>}
                      {has.source && <small>{has.source}</small>}
                    </span>
                  </td>
                  <td className="member-table-choice">
                    <SelectField
                      label={t("controlAdmin:access.libraries.directFor", { library: library.name })}
                      hideLabel
                      compact
                      value={library.direct ?? ""}
                      disabled={busy}
                      onChange={(role) => void write(() => (role
                        ? api(`/api/library/libraries/${library.id}/members`, body({ role }))
                        : api(`/api/library/libraries/${library.id}/members/${base}`, del)))}
                      options={[{ value: "", label: noDirectLabel(library) }, ...LIBRARY_ROLES.map((role) => ({ value: role, label: libraryRole(role) }))]}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="member-card-note">{t("controlAdmin:member.libraries.note")}</p>
      </section>

      {overview.inbox && (
        <section className="member-card" aria-labelledby="member-inbox-title">
          <h2 id="member-inbox-title">
            <Inbox size={17} aria-hidden="true" />
            {t("controlAdmin:access.family.inbox")}
          </h2>
          <p className="access-muted">{t("controlAdmin:member.libraries.inboxHint", { name })}</p>
          <div className="member-inbox-row">
            <span className="member-table-primary">
              <strong>{t("controlAdmin:access.family.inboxReviewer")}</strong>
              {overview.inbox.inherited.some((g) => g.via === "group") && (
                <small>{overview.inbox.inherited.filter((g) => g.via === "group").map((g) => t("controlAdmin:access.fromGroup", { group: g.groupName ?? "" })).join(" · ")}</small>
              )}
            </span>
            <SelectField
              label={t("controlAdmin:access.family.inboxReviewer")}
              hideLabel
              compact
              value={inboxLevel(overview.inbox)}
              disabled={busy}
              onChange={(level) => void write(() => (level
                ? api("/api/storage/app-storage/parts/inbox/reviewers", body({ level }))
                : api(`/api/storage/app-storage/parts/inbox/reviewers/${base}`, del)))}
              options={[
                { value: "", label: t("controlAdmin:access.family.notReviewer") },
                { value: "details", label: t("controlAdmin:appStorage.reviewers.levels.details") },
                { value: "keep", label: t("controlAdmin:appStorage.reviewers.levels.keep") }
              ]}
            />
          </div>
        </section>
      )}
    </>
  );
}
