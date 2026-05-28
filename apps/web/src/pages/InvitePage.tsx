import { useState, useEffect } from "react";
import { api } from "../api";
import { Shell } from "../app/Shell";
import { AccountForm } from "../shared/AccountForm";
import { MessageBox } from "../shared/MessageBox";
import { navigate } from "../router";

export function InvitePage({ token, onSignedIn }: { token: string; onSignedIn: () => Promise<void> }) {
  const [inviteRole, setInviteRole] = useState<string>("");
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ invite: { role: string } }>(`/api/invites/${token}`)
      .then((payload) => setInviteRole(payload.invite.role))
      .catch((err) => setError(err instanceof Error ? err.message : "Invite is unavailable"));
  }, [token]);

  if (error) {
    return <Shell><MessageBox tone="error" title="Invite unavailable">{error}</MessageBox></Shell>;
  }

  return (
    <AccountForm
      title="Accept invite"
      eyebrow={inviteRole ? `${inviteRole} account` : "Invite"}
      submitLabel="Create account"
      helper="Invite links are single-use. After your account is created, the invite is consumed."
      onSubmit={async (payload) => {
        await api(`/api/invites/${token}/accept`, { method: "POST", body: JSON.stringify(payload) });
        await onSignedIn();
        navigate("/");
      }}
    />
  );
}
