import { useCallback, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Gamepad2 } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { RefreshButton } from "../../../shared/RefreshButton";
import { ControlSectionHead } from "../ControlSectionHead";

interface GamesStatus {
  configured: boolean;
  reason: string | null;
  url: string | null;
  secretSet: boolean;
  server: { ok: boolean; version: string | null; error: string | null } | null;
}

const CONFIG_DOC = "https://github.com/isputnikdotnet/isputnik.home/blob/main/docs/configuration.md#games";

// Settings → Games: how the link to isputnik.games stands. Read-only by design
// (docs/games-platform-plan.md): the two settings are environment variables on
// the container, the way the owner decided, so this page shows what they are
// set to and whether the games server answers — not fields to edit. The secret
// is never shown, only whether one is set.
export function GamesSection() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [status, setStatus] = useState<GamesStatus | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(
    () =>
      api<GamesStatus>("/api/games/admin/status")
        .then((payload) => { setStatus(payload); setError(""); })
        .catch((err: unknown) => { setError(err instanceof Error ? err.message : t("controlAdmin:games.loadFailed")); throw err; }),
    [t]
  );

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  const dash = "—";
  const state = !status ? null : !status.configured ? "off" : status.server?.ok ? "on" : "unreachable";

  return (
    <>
      <ControlSectionHead
        section="games"
        icon={<Gamepad2 size={30} />}
        iconClassName="blue"
        description={t("controlAdmin:games.headDescription")}
      />

      <section className="config-block">
        <p className="muted">{t("controlAdmin:games.intro")}</p>

        {error && <MessageBox tone="error" title={t("controlAdmin:games.loadFailed")}>{error}</MessageBox>}
        {!status && !error && <p className="muted">{t("controlAdmin:ui.loading")}</p>}

        {status && (
          <>
            {state === "on" && (
              <MessageBox tone="success" title={t("controlAdmin:games.onTitle")}>
                {t("controlAdmin:games.onBody", { version: status.server?.version ?? dash })}
              </MessageBox>
            )}
            {state === "unreachable" && (
              <MessageBox tone="warning" title={t("controlAdmin:games.unreachableTitle")}>
                {t("controlAdmin:games.unreachableBody", { url: status.url ?? dash, error: status.server?.error ?? dash })}
              </MessageBox>
            )}
            {state === "off" && (
              <MessageBox tone="info" title={t("controlAdmin:games.offTitle")}>
                {status.reason ?? t("controlAdmin:games.offBody")}
              </MessageBox>
            )}

            <dl className="games-status" aria-label={t("controlAdmin:games.statusLabel")}>
              <div>
                <dt>{t("controlAdmin:games.gateway")}</dt>
                <dd>{status.configured ? t("controlAdmin:games.gatewayOn") : t("controlAdmin:games.gatewayOff")}</dd>
              </div>
              <div>
                <dt>{t("controlAdmin:games.url")}</dt>
                <dd>{status.url ? <code>{status.url}</code> : dash}</dd>
              </div>
              <div>
                <dt>{t("controlAdmin:games.secret")}</dt>
                <dd>{status.secretSet ? t("controlAdmin:games.secretSet") : t("controlAdmin:games.secretUnset")}</dd>
              </div>
              <div>
                <dt>{t("controlAdmin:games.server")}</dt>
                <dd>
                  {!status.server
                    ? t("controlAdmin:games.serverNotAsked")
                    : status.server.ok
                      ? t("controlAdmin:games.serverVersion", { version: status.server.version ?? dash })
                      : status.server.error ?? t("controlAdmin:games.serverDown")}
                </dd>
              </div>
            </dl>

            <p className="muted">
              <Trans
                i18nKey="games.howToSet"
                ns="controlAdmin"
                components={{ url: <code />, secret: <code />, lnk: <a href={CONFIG_DOC} target="_blank" rel="noreferrer" /> }}
              />
            </p>

            <div className="mail-actions">
              <RefreshButton onRefresh={load} label={t("controlAdmin:games.checkAgain")} compact={false} />
            </div>
          </>
        )}
      </section>
    </>
  );
}
