import { useEffect, useState } from "react";
import { isIos, isStandalone } from "./platform";

// Chrome/Android fires this before showing its own install UI; we capture it so
// our own buttons can trigger the prompt. Not in the TS DOM lib yet.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

// Module-level capture so the event (which can fire before any component mounts)
// is never missed; components subscribe via the hook below.
let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    notify();
  });
}

export interface InstallState {
  /** Running as the installed (standalone) app. */
  installed: boolean;
  /** A one-tap install prompt is available (Android / desktop Chrome). */
  canPrompt: boolean;
  /** iOS Safari, not installed — show manual "Add to Home Screen" steps. */
  iosInstructions: boolean;
  /** Trigger the browser install prompt (no-op if unavailable). */
  promptInstall: () => Promise<void>;
}

export function useInstall(): InstallState {
  const [, force] = useState(0);

  useEffect(() => {
    const rerender = () => force((n) => n + 1);
    listeners.add(rerender);
    return () => { listeners.delete(rerender); };
  }, []);

  const installed = isStandalone();

  const promptInstall = async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    notify();
  };

  return {
    installed,
    canPrompt: !installed && deferred !== null,
    iosInstructions: !installed && isIos() && deferred === null,
    promptInstall
  };
}
