import { Download, Share, Smartphone } from "lucide-react";
import { useInstall } from "./useInstall";

// Install affordance for the mobile app. Always shown when NOT already running
// as the installed app: a one-tap button when the browser offers it (Android /
// desktop Chrome), otherwise clear manual "Add to Home Screen" steps (iOS, and
// browsers that don't support an install prompt). Hidden inside the installed app.
export function InstallCta({
  title = "Install the mobile app",
  subtitle = "Add iSputnik to your phone's home screen to listen offline, with lock-screen and Bluetooth controls."
}: {
  title?: string;
  subtitle?: string;
}) {
  const { installed, canPrompt, iosInstructions, promptInstall } = useInstall();

  if (installed) return null;

  return (
    <div className="install-cta">
      <span className="install-cta-icon" aria-hidden="true">
        <Smartphone size={20} />
      </span>
      <div className="install-cta-text">
        <strong>{title}</strong>
        <span>{subtitle}</span>
        {!canPrompt && (
          iosInstructions ? (
            <span className="install-cta-steps">
              In Safari: tap <Share size={13} aria-label="the Share button" /> → “Add to Home Screen”.
            </span>
          ) : (
            <span className="install-cta-steps">
              On your phone, open this page in Chrome or Safari and choose “Add to Home Screen” (in Chrome, the ⋮ menu → “Install app”).
            </span>
          )
        )}
      </div>
      {canPrompt && (
        <button type="button" className="install-cta-btn" onClick={() => void promptInstall()}>
          <Download size={16} aria-hidden="true" />
          <span>Install</span>
        </button>
      )}
    </div>
  );
}
