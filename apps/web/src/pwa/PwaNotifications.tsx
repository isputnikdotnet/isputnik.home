import { RefreshCw, ServerOff, ShieldAlert, WifiOff } from "lucide-react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { useConnectionStatus } from "./useOnlineStatus";

export function PwaNotifications() {
  const connection = useConnectionStatus();

  const { needRefresh: [updating] } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      // Poll for updates while the app is open (browsers auto-check on navigation,
      // but the player can run for hours without a full navigation).
      setInterval(() => {
        if (!registration.installing && navigator.onLine) {
          registration.update().catch(() => {});
        }
      }, 30 * 60 * 1000);
    }
  });

  return (
    <>
      {connection !== "online" && (
        <div className="offline-status-banner" role="status" aria-live="polite">
          {connection === "offline" && (
            <>
              <WifiOff size={14} aria-hidden="true" />
              <span>No internet connection</span>
            </>
          )}
          {/* Not the server's doing: something on this network answered in its place.
              Naming it here is the difference between "the app is broken" and one
              call to whoever runs the Wi-Fi. */}
          {connection === "blocked" && (
            <>
              <ShieldAlert size={14} aria-hidden="true" />
              <span>Blocked by this network</span>
            </>
          )}
          {connection === "unreachable" && (
            <>
              <ServerOff size={14} aria-hidden="true" />
              <span>Server not responding</span>
            </>
          )}
        </div>
      )}
      {updating && (
        <div className="sw-update-banner" role="status" aria-live="polite">
          <RefreshCw size={15} aria-hidden="true" className="sw-update-spinner" />
          <span>Updating iSputnik…</span>
        </div>
      )}
    </>
  );
}
