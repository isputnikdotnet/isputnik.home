import { useState, type ReactNode } from "react";
import { ChevronDown, Download, Share, Smartphone } from "lucide-react";
import { useInstall } from "./useInstall";
import { isIos } from "./platform";

function isAndroid() {
  return /android/i.test(window.navigator.userAgent);
}

function AppleGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M16.365 1.43c0 1.14-.493 2.27-1.177 3.08-.744.9-1.99 1.57-2.987 1.57-.12 0-.23-.02-.3-.03-.01-.06-.04-.22-.04-.39 0-1.15.572-2.27 1.206-2.98.804-.94 2.142-1.64 3.248-1.68.03.13.05.28.05.43zm4.565 15.71c-.03.07-.463 1.58-1.518 3.12-.945 1.34-1.94 2.71-3.43 2.71-1.517 0-1.9-.88-3.63-.88-1.698 0-2.302.91-3.67.91-1.377 0-2.332-1.26-3.428-2.8-1.287-1.82-2.323-4.63-2.323-7.28 0-4.28 2.797-6.55 5.552-6.55 1.448 0 2.675.95 3.6.95.865 0 2.222-1.01 3.902-1.01.613 0 2.886.06 4.374 2.19-.13.07-2.383 1.37-2.383 4.19 0 3.26 2.854 4.42 2.955 4.45z" />
    </svg>
  );
}

function AndroidGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="#3ddc84" aria-hidden="true">
      <path d="M17.523 15.341a1 1 0 110-2 1 1 0 010 2m-11.046 0a1 1 0 110-2 1 1 0 010 2m11.405-6.02l1.997-3.459a.416.416 0 00-.72-.416l-2.022 3.503A12.6 12.6 0 0012 7.851c-1.853 0-3.59.393-5.137 1.099L4.841 5.447a.416.416 0 10-.72.416L6.118 9.32C2.689 11.187.343 14.659 0 18.761h24c-.343-4.102-2.689-7.574-6.118-9.44" />
    </svg>
  );
}

// Expandable platform panel with numbered steps.
function PlatformPanel({
  glyph,
  name,
  sub,
  defaultOpen = false,
  children
}: {
  glyph: ReactNode;
  name: string;
  sub: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`install-platform${open ? " open" : ""}`}>
      <button type="button" className="install-platform-row" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="install-platform-glyph">{glyph}</span>
        <span className="install-platform-name">{name}<span>{sub}</span></span>
        <ChevronDown className="install-platform-chev" size={18} aria-hidden="true" />
      </button>
      {open && <div className="install-platform-steps">{children}</div>}
    </div>
  );
}

const iosSteps = (
  <ol>
    <li>Open this page in <strong>Safari</strong>.</li>
    <li>Tap the Share button <Share className="install-inline-glyph" size={14} aria-label="Share" />.</li>
    <li>Choose <strong>“Add to Home Screen”</strong>.</li>
  </ol>
);

const androidSteps = (
  <ol>
    <li>Open this page in <strong>Chrome</strong>.</li>
    <li>Tap the <strong>⋮</strong> menu (top-right).</li>
    <li>Choose <strong>“Install app”</strong> (or “Add to Home screen”).</li>
  </ol>
);

// Polished, platform-aware install card for the mobile app. Hidden once running
// as the installed app. Shows the detected platform's instructions; falls back to
// both phone platforms on desktop, and to a one-tap button when the browser offers it.
export function InstallCard({
  title = "Install the mobile app",
  subtitle = "Add iSputnik to your home screen to listen offline, with lock-screen and Bluetooth controls."
}: {
  title?: string;
  subtitle?: string;
}) {
  const { installed, canPrompt, promptInstall } = useInstall();
  if (installed) return null;

  const ios = isIos();
  const android = isAndroid();

  return (
    <div className="install-card">
      <div className="install-card-head">
        <span className="install-card-icon" aria-hidden="true"><Smartphone size={22} /></span>
        <div className="install-card-text">
          <strong>{title}</strong>
          <span>{subtitle}</span>
        </div>
      </div>

      <div className="install-platform-list">
        {canPrompt ? (
          <div className="install-platform">
            <div className="install-platform-row static">
              <span className="install-platform-glyph">{android ? <AndroidGlyph /> : <Smartphone size={20} />}</span>
              <span className="install-platform-name">{android ? "Android" : "This device"}<span>Chrome &amp; Edge</span></span>
              <button type="button" className="install-cta-btn" onClick={() => void promptInstall()}>
                <Download size={16} aria-hidden="true" />
                <span>Install</span>
              </button>
            </div>
          </div>
        ) : ios ? (
          <PlatformPanel glyph={<AppleGlyph />} name="iPhone & iPad" sub="Safari" defaultOpen>{iosSteps}</PlatformPanel>
        ) : android ? (
          <PlatformPanel glyph={<AndroidGlyph />} name="Android" sub="Chrome & Edge" defaultOpen>{androidSteps}</PlatformPanel>
        ) : (
          <>
            <PlatformPanel glyph={<AppleGlyph />} name="iPhone & iPad" sub="Safari">{iosSteps}</PlatformPanel>
            <PlatformPanel glyph={<AndroidGlyph />} name="Android" sub="Chrome & Edge">{androidSteps}</PlatformPanel>
          </>
        )}
      </div>
    </div>
  );
}
