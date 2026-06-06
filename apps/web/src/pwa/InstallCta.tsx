import { Download, Share } from "lucide-react";
import { useInstall } from "./useInstall";

// Adaptive install affordance: a one-tap button on Android/desktop, manual
// Home-Screen steps on iOS, and nothing once the app is already installed.
export function InstallCta({
  title = "Install iSputnik",
  subtitle = "Add it to your home screen — it opens offline."
}: {
  title?: string;
  subtitle?: string;
}) {
  const { installed, canPrompt, iosInstructions, promptInstall } = useInstall();

  if (installed) return null;

  if (canPrompt) {
    return (
      <div className="install-cta">
        <div className="install-cta-text">
          <strong>{title}</strong>
          <span>{subtitle}</span>
        </div>
        <button type="button" className="install-cta-btn" onClick={() => void promptInstall()}>
          <Download size={16} aria-hidden="true" />
          <span>Install app</span>
        </button>
      </div>
    );
  }

  if (iosInstructions) {
    return (
      <div className="install-cta">
        <div className="install-cta-text">
          <strong>{title}</strong>
          <span>
            Tap <Share size={13} aria-label="the Share button" /> in Safari, then “Add to Home Screen”.
          </span>
        </div>
      </div>
    );
  }

  return null;
}
