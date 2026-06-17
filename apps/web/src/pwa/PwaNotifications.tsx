import { RefreshCw, WifiOff } from "lucide-react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { useOnlineStatus } from "./useOnlineStatus";

export function PwaNotifications() {
  const online = useOnlineStatus();

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
      {!online && (
        <div className="offline-status-banner" role="status" aria-live="polite">
          <WifiOff size={14} aria-hidden="true" />
          <span>No internet connection</span>
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
