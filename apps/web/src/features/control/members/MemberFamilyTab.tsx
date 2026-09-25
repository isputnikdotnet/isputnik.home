import { useTranslation } from "react-i18next";
import { BookOpenText, GitBranch, TreeDeciduous } from "lucide-react";
import { api } from "../../../api";
import { SelectField } from "../../../shared/SelectField";
import { useGrantWords, type AccessSubjectState } from "../access/AccessTabs";
import type { GrantRole } from "../access/types";

// The Family tree and Stories tabs of a member's page: the tree itself (open
// unless blocked, D14; living relatives' details by a switch, D15) and the
// branches they may edit; and, on its own tab, the story collections they can
// reach. One component, since the two share the access wording.

const COLLECTION_ROLES = ["viewer", "contributor", "manager", "deny"] as const;

export function MemberFamilyTab({ state, part }: { state: AccessSubjectState; part: "tree" | "stories" }) {
  const { t } = useTranslation(["controlAdmin", "family", "stories"]);
  const { overview, people, busy, write, base, body, del } = state;
  const { noDirectLabel, access: grantAccess } = useGrantWords();
  if (!overview) return null;

  const collectionRole = (role: GrantRole) => t(`stories:collections.roles.${role === "member" ? "viewer" : role}`);
  const access = (view: Parameters<typeof grantAccess>[0]) => grantAccess(view, collectionRole);
  if (part === "stories") {
    return (
      <section className="member-card" aria-labelledby="member-stories-title">
        <h2 id="member-stories-title">
          <BookOpenText size={17} aria-hidden="true" />
          {t("controlAdmin:access.family.collections")}
        </h2>
        <p className="access-muted">{t("controlAdmin:member.family.storiesHint")}</p>
        {overview.collections.length === 0
          ? <p className="access-muted">{t("controlAdmin:access.family.noCollections")}</p>
          : (
            <table className="member-table member-libraries">
              <thead>
                <tr>
                  <th>{t("controlAdmin:member.family.colCollection")}</th>
                  <th>{t("controlAdmin:member.libraries.colAccess")}</th>
                  <th>{t("controlAdmin:member.libraries.colDirect")}</th>
                </tr>
              </thead>
              <tbody>
                {overview.collections.map((collection) => {
                  const has = access(collection);
                  return (
                    <tr key={collection.id}>
                      <td><strong>{collection.name}</strong></td>
                      <td>
                        <span className="member-table-primary">
                          {has.none
                            ? <span className="access-muted">{has.role}</span>
                            : <span className={`status-badge ${has.blocked ? "locked" : "active"}`}>{has.role}</span>}
                          {has.source && <small>{has.source}</small>}
                        </span>
                      </td>
                      <td className="member-table-choice">
                        <SelectField
                          label={t("controlAdmin:access.family.collectionFor", { collection: collection.name })}
                          hideLabel
                          compact
                          value={collection.direct ?? ""}
                          disabled={busy}
                          onChange={(role) => void write(() => (role
                            ? api(`/api/stories/collections/${collection.id}/access`, body({ role }))
                            : api(`/api/stories/collections/${collection.id}/access/${base}`, del)))}
                          options={[{ value: "", label: noDirectLabel(collection) }, ...COLLECTION_ROLES.map((role) => ({ value: role, label: t(`stories:collections.roles.${role}`) }))]}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
      </section>
    );
  }

  return (
    <>
      <section className="member-card" aria-labelledby="member-tree-title">
        <h2 id="member-tree-title">
          <TreeDeciduous size={17} aria-hidden="true" />
          {t("controlAdmin:access.family.tree")}
        </h2>
        <p className="access-muted">{t("controlAdmin:member.family.treeHint")}</p>
        <div className="member-inbox-row">
          <span className="member-table-primary">
            <strong>{t("controlAdmin:access.family.seeTree")}</strong>
            {overview.tree.blockedBy.length > 0
              ? <small>{t("controlAdmin:access.family.blockedBy", { names: overview.tree.blockedBy.map((n) => n ?? t("controlAdmin:access.family.everyone")).join(", ") })}</small>
              : <small>{overview.tree.canSee ? t("controlAdmin:access.family.seesIt") : t("controlAdmin:access.blocked")}</small>}
          </span>
          <SelectField
            label={t("controlAdmin:access.family.seeTree")}
            hideLabel
            compact
            value={overview.tree.blocked ? "no" : "yes"}
            disabled={busy}
            onChange={(value) => void write(() => api(`/api/family-tree/viewers/${base}`, { method: "PUT", body: JSON.stringify({ canSee: value === "yes" }) }))}
            options={[
              { value: "yes", label: t("controlAdmin:access.family.canSee") },
              { value: "no", label: t("controlAdmin:access.family.cannotSee") }
            ]}
          />
        </div>
        {people && (
          <label className="member-toggle">
            <input
              type="checkbox"
              checked={people.settings.showLivingDetails}
              disabled={busy}
              onChange={(event) => { const on = event.target.checked; void write(() => api(`/api/family-tree/viewers/${base}`, { method: "PUT", body: JSON.stringify({ showLivingDetails: on }) })); }}
            />
            <span>
              {t("controlAdmin:access.family.living")}
              <small>{t("controlAdmin:access.family.livingHint")}</small>
              {overview.tree.seesLivingDetails && !people.settings.showLivingDetails && <small>{t("controlAdmin:access.family.livingViaGroup")}</small>}
            </span>
          </label>
        )}
      </section>

      <section className="member-card" aria-labelledby="member-branches-edit-title">
        <h2 id="member-branches-edit-title">
          <GitBranch size={17} aria-hidden="true" />
          {t("controlAdmin:access.family.branches")}
        </h2>
        <p className="access-muted">{t("controlAdmin:member.family.branchesHint")}</p>
        {overview.branches.length === 0
          ? <p className="access-muted">{t("controlAdmin:access.family.noBranches")}</p>
          : (
            <table className="member-table member-libraries">
              <thead>
                <tr>
                  <th>{t("controlAdmin:member.photos.colBranch")}</th>
                  <th>{t("controlAdmin:member.family.colEditing")}</th>
                  <th>{t("controlAdmin:member.libraries.colDirect")}</th>
                </tr>
              </thead>
              <tbody>
                {overview.branches.map((branch) => {
                  const viaGroups = branch.inherited.filter((g) => g.via === "group");
                  const editor = branch.direct === "contributor" || viaGroups.some((g) => g.role === "contributor");
                  const blocked = branch.direct === "deny" || viaGroups.some((g) => g.role === "deny");
                  return (
                    <tr key={branch.id}>
                      <td>
                        <span className="member-table-primary">
                          <strong>{branch.name}</strong>
                          <small>{t("family:common.counts.person", { count: branch.people })}</small>
                        </span>
                      </td>
                      <td>
                        <span className="member-table-primary">
                          {blocked
                            ? <span className="status-badge locked">{t("family:tagAccess.roleBlocked")}</span>
                            : editor
                              ? <span className="status-badge active">{t("family:tagAccess.roleEditor")}</span>
                              : <span className="access-muted">{t("controlAdmin:access.family.cannotEdit")}</span>}
                          {viaGroups.length > 0 && (
                            <small>{viaGroups.map((g) => t("controlAdmin:access.viaGroup", { role: g.role === "deny" ? t("family:tagAccess.roleBlocked") : t("family:tagAccess.roleEditor"), group: g.groupName ?? "" })).join(" · ")}</small>
                          )}
                        </span>
                      </td>
                      <td className="member-table-choice">
                        <SelectField
                          label={t("controlAdmin:access.family.branchFor", { branch: branch.name })}
                          hideLabel
                          compact
                          value={branch.direct ?? ""}
                          disabled={busy}
                          onChange={(role) => void write(() => (role
                            ? api(`/api/family-tree/tags/${branch.id}/editors`, body({ role }))
                            : api(`/api/family-tree/tags/${branch.id}/editors/${base}`, del)))}
                          options={[
                            { value: "", label: t("controlAdmin:access.family.cannotEdit") },
                            { value: "contributor", label: t("family:tagAccess.roleEditor") },
                            { value: "deny", label: t("family:tagAccess.roleBlocked") }
                          ]}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
      </section>

    </>
  );
}
