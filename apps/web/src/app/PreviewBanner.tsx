import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { useSession } from "./SessionContext";
import { userAccessHref } from "../features/control/links";
import { Button } from "../shared/Button";
import { MessageBox } from "../shared/MessageBox";
import { clearCachedUser } from "../offline/downloads";

// While an admin previews the app as a member (server: core/preview.ts), every
// page says so, and how to stop. The session's `user` IS the member then;
// previewBy is the admin looking.
export function PreviewBanner() {
  const { t } = useTranslation(["common"]);
  const { user } = useSession();
  const [stopping, setStopping] = useState(false);
  if (!user?.previewBy) return null;
  const stop = async () => {
    setStopping(true);
    try {
      await api("/api/preview", { method: "DELETE" });
    } finally {
      // Back to where a preview is started, as the admin again — with no cached
      // identity to start the next load as the member.
      clearCachedUser();
      window.location.href = userAccessHref(user.id, "photos");
    }
  };
  return (
    <MessageBox
      tone="warning"
      className="preview-banner"
      title={t("common:preview.title", { name: user.displayName })}
      action={<Button variant="primary" compact disabled={stopping} onClick={() => void stop()}>{stopping ? t("common:preview.stopping") : t("common:preview.stop")}</Button>}
    >
      {t("common:preview.body")}
    </MessageBox>
  );
}
