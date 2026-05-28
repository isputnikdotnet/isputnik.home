import { api } from "../api";
import { AccountForm } from "../shared/AccountForm";
import { navigate } from "../router";

export function InstallPage({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  return (
    <AccountForm
      title="Create the setup admin"
      eyebrow="First run"
      submitLabel="Create admin"
      helper="This account is marked as protected in SQLite and cannot be deleted from user management."
      onSubmit={async (payload) => {
        await api("/api/setup/admin", { method: "POST", body: JSON.stringify(payload) });
        await onSignedIn();
        navigate("/");
      }}
    />
  );
}
