import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { Shell } from "../app/Shell";
import { AccountForm } from "../shared/AccountForm";
import { MessageBox } from "../shared/MessageBox";
import { navigate } from "../router";

export function InvitePage({ token, onSignedIn }: { token: string; onSignedIn: () => Promise<void> }) {
  const { t } = useTranslation();
  const [inviteRole, setInviteRole] = useState<string>("");
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ invite: { role: string } }>(`/api/invites/${token}`)
      .then((payload) => setInviteRole(payload.invite.role))
      .catch((err) => setError(err instanceof Error ? err.message : t("invite.unavailableFallback")));
  }, [token, t]);

  if (error) {
    return <Shell><MessageBox tone="error" title={t("invite.unavailableTitle")}>{error}</MessageBox></Shell>;
  }

  return (
    <AccountForm
      title={t("invite.title")}
      eyebrow={inviteRole ? t("invite.eyebrowRole", { role: inviteRole }) : t("invite.eyebrow")}
      submitLabel={t("invite.submit")}
      helper={t("invite.helper")}
      onSubmit={async (payload) => {
        await api(`/api/invites/${token}/accept`, { method: "POST", body: JSON.stringify(payload) });
        await onSignedIn();
        navigate("/");
      }}
    />
  );
}
