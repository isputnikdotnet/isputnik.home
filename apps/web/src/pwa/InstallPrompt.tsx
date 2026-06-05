import { useEffect, useState } from "react";
import { Share, X } from "lucide-react";
import { isIos, isStandalone } from "./platform";

// Chrome/Android fires this before showing its own install UI; we capture it to
// trigger the prompt from our own button. Not in the TS DOM lib yet.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "isputnik-install-dismissed";

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === "1");

  useEffect(() => {
    if (isStandalone() || dismissed) return;

    const onBeforeInstall = (e: Event) => {
      e.preventDefault(); // stop Chrome's mini-infobar so we control the moment
      setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);

    // iOS never fires beforeinstallprompt, so surface the manual instructions there.
    if (isIos()) setShowIosHint(true);

    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstall);
  }, [dismissed]);

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, "1");
    setDismissed(true);
  };

  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    setDeferred(null);
  };

  if (dismissed || isStandalone()) return null;
  if (!deferred && !showIosHint) return null;

  return (
    <div className="install-prompt" role="dialog" aria-label="Install iSputnik">
      <img className="install-prompt-icon" src="/Assets/brand/pwa-icon-192.png" alt="" width={40} height={40} />
      <div className="install-prompt-body">
        {deferred ? (
          <>
            <strong>Install iSputnik</strong>
            <span>Add it to your home screen for offline listening.</span>
          </>
        ) : (
          <>
            <strong>Add iSputnik to your Home Screen</strong>
            <span>
              Tap <Share size={14} aria-label="the Share button" /> in Safari, then “Add to Home Screen”.
            </span>
          </>
        )}
      </div>
      {deferred && (
        <button className="install-prompt-action" onClick={install}>
          Install
        </button>
      )}
      <button className="install-prompt-close" onClick={dismiss} aria-label="Dismiss">
        <X size={16} />
      </button>
    </div>
  );
}
