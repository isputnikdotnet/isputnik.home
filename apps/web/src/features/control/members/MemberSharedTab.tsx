import { useTranslation } from "react-i18next";
import { Share2 } from "lucide-react";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import type { AccessSubjectState } from "../access/AccessTabs";

// The Shared with them tab of a member's page: what someone sent them with
// Send to — an album, a book, photos, a story — each with who sent it and when,
// and Remove to take it back.

export function MemberSharedTab({ state, name }: { state: AccessSubjectState; name: string }) {
  const { t } = useTranslation(["controlAdmin"]);
  const { overview, busy, write, del } = state;
  if (!overview) return null;
  return (
    <section className="member-card" aria-labelledby="member-shared-title">
      <h2 id="member-shared-title">
        <Share2 size={17} aria-hidden="true" />
        {t("controlAdmin:access.tabs.sharedWith")}
      </h2>
      {overview.shares.length === 0
        ? (
          <div className="access-empty">
            <strong>{t("controlAdmin:access.shared.emptyTitle", { name })}</strong>
            <p className="access-muted">{t("controlAdmin:access.shared.emptyBody", { name })}</p>
          </div>
        )
        : (
          <>
            <p className="access-muted">{t("controlAdmin:member.shared.hint", { name })}</p>
            <table className="member-table member-people">
              <thead>
                <tr>
                  <th>{t("controlAdmin:member.shared.colItem")}</th>
                  <th>{t("controlAdmin:member.shared.colFrom")}</th>
                  <th><span className="sr-only">{t("controlAdmin:member.photos.colActions")}</span></th>
                </tr>
              </thead>
              <tbody>
                {overview.shares.map((share) => (
                  <tr key={share.id}>
                    <td>
                      <span className="member-table-primary">
                        <strong>{share.title ?? t("controlAdmin:access.shared.untitled")}</strong>
                        <small>{t(`controlAdmin:access.shared.kinds.${share.module as "gallery_album"}`, { defaultValue: share.module })}</small>
                      </span>
                    </td>
                    <td>
                      <span className="member-table-primary">
                        {share.from && <strong>{share.from}</strong>}
                        <small>{new Date(share.createdAt).toLocaleDateString()}</small>
                      </span>
                    </td>
                    <td className="member-table-actions">
                      <Button variant="secondary" compact disabled={busy} onClick={() => void write(() => api(`/api/shares/user/${share.id}`, del))}>
                        {t("controlAdmin:access.remove")}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
    </section>
  );
}
