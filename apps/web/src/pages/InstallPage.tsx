import { useTranslation } from "react-i18next";
import { api } from "../api";
import { AccountForm } from "../shared/AccountForm";
import { navigate } from "../router";

export function InstallPage({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const { t } = useTranslation();
  return (
    <AccountForm
      title={t("install.title")}
      eyebrow={t("install.eyebrow")}
      submitLabel={t("install.submit")}
      helper={t("install.helper")}
      onSubmit={async (payload) => {
        await api("/api/setup/admin", { method: "POST", body: JSON.stringify(payload) });
        await onSignedIn();
        navigate("/");
      }}
    />
  );
}
