// The setup guide the first administrator sees after signing in.
//
// It configures nothing new. Every step writes through the same endpoint its Control
// panel page uses, so anything set here can be changed there afterwards and nothing
// here is a second source of truth. What the guide adds is ORDER: storage first,
// because no library can exist without it; then email, because half the security
// features are letters nobody receives until it works; then the theme.
//
// Skipping is a real answer — it marks the guide done and stops it asking on every
// sign-in — and Settings → About links back here for whenever the answer changes.
import { useEffect, useState } from "react";
import {
  ArrowLeft, ArrowRight, Check, Folder, HardDrive, Lock, Mail, Palette, ShieldCheck, Trash2
} from "lucide-react";
import packageInfo from "../../../../package.json";
import { api, type PublicUser } from "../api";
import { Button } from "../shared/Button";
import { Field } from "../shared/Field";
import { MessageBox } from "../shared/MessageBox";
import { ThemePicker, type Theme } from "../shared/ThemePicker";
import { ToggleSwitch } from "../shared/ToggleSwitch";
import { navigate } from "../router";
import { FolderPickerModal } from "../features/control/libraries/FolderPickerModal";
import type { LibrarySettings, StorageRoot } from "../features/control/types";

/** As `/api/config/mail` returns it. The stored password is never echoed back — only
 *  whether there is one — so the field below starts empty and is sent only when it has
 *  been typed into. */
interface MailSettings {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  fromAddress: string;
  fromName: string;
  hasPassword: boolean;
}

interface SecurityPolicy {
  lockoutThreshold: number;
  lockoutMinutes: number;
  ipFailThreshold: number;
  ipFailWindowMinutes: number;
  ipAutoblockMinutes: number;
  alertNewIpSignIn: boolean;
}

type StepKey = "storage" | "bin" | "email" | "alerts" | "theme";

// Two of these depend on the step before them, and say so rather than being hidden: the
// Recycle Bin needs a container to live in, and an alert needs a way to reach you. A
// step you cannot use yet still explains what it is for, and where to come back to.
const STEPS: { key: StepKey; title: string; note: string; icon: typeof HardDrive }[] = [
  { key: "storage", title: "Storage", note: "Where files live", icon: HardDrive },
  { key: "bin", title: "Recycle Bin", note: "Where deleted files wait", icon: Trash2 },
  { key: "email", title: "Email", note: "For alerts and codes", icon: Mail },
  { key: "alerts", title: "Security alerts", note: "Tell me about sign-ins", icon: ShieldCheck },
  { key: "theme", title: "Appearance", note: "How it looks", icon: Palette }
];

const APP_VERSION = packageInfo.version;

export function WelcomePage({ user }: { user: PublicUser }) {
  const [step, setStep] = useState<StepKey>("storage");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Storage
  const [thumbnailPath, setThumbnailPath] = useState("");
  const [settings, setSettings] = useState<LibrarySettings | null>(null);
  const [roots, setRoots] = useState<StorageRoot[]>([]);
  const [rootName, setRootName] = useState("Media");
  const [rootPath, setRootPath] = useState("");
  const [storageSaved, setStorageSaved] = useState("");

  // Recycle Bin
  const [binPath, setBinPath] = useState<string | null>(null);
  const [binEditable, setBinEditable] = useState(true);
  const [binPickerOpen, setBinPickerOpen] = useState(false);
  const [binSaved, setBinSaved] = useState(false);

  // Email
  const [mail, setMail] = useState<MailSettings | null>(null);
  const [password, setPassword] = useState("");
  const [mailSaved, setMailSaved] = useState(false);
  const [testSent, setTestSent] = useState(false);
  const [policy, setPolicy] = useState<SecurityPolicy | null>(null);
  const [alertsSaved, setAlertsSaved] = useState(false);

  // Appearance
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    // Five reads, once, in parallel: this page is only ever opened by an admin, and
    // every step needs to open on what is already configured rather than on blanks.
    Promise.all([
      api<{ settings: LibrarySettings }>("/api/library/settings").catch(() => null),
      api<{ roots: StorageRoot[] }>("/api/storage/roots").catch(() => null),
      api<{ mail: MailSettings }>("/api/config/mail").catch(() => null),
      api<{ config: { defaultTheme: Theme } }>("/api/config").catch(() => null),
      api<{ policy: SecurityPolicy }>("/api/security").catch(() => null),
      api<{ path: string | null; editable: boolean }>("/api/storage/trash-root").catch(() => null)
    ]).then(([librarySettings, rootList, mailPayload, config, security, bin]) => {
      if (librarySettings) {
        setSettings(librarySettings.settings);
        setThumbnailPath(librarySettings.settings.thumbnailPath);
      }
      if (rootList) setRoots(rootList.roots);
      if (mailPayload) setMail(mailPayload.mail);
      if (config) setTheme(config.config.defaultTheme);
      if (security) setPolicy(security.policy);
      if (bin) {
        setBinPath(bin.path);
        setBinEditable(bin.editable);
      }
    });
  }, []);

  const run = async (what: () => Promise<void>, whenFailed: string) => {
    setBusy(true);
    setError("");
    try {
      await what();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : whenFailed);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveThumbnailPath = () => run(async () => {
    const payload = await api<{ settings: LibrarySettings }>("/api/library/settings", {
      method: "PATCH",
      body: JSON.stringify({ thumbnailPath })
    });
    setSettings(payload.settings);
    setStorageSaved("Thumbnail storage saved.");
  }, "Unable to save the thumbnail path");

  const addContainer = () => run(async () => {
    await api("/api/storage/roots", {
      method: "POST",
      body: JSON.stringify({ name: rootName, path: rootPath })
    });
    const payload = await api<{ roots: StorageRoot[] }>("/api/storage/roots");
    setRoots(payload.roots);
    setRootPath("");
    setStorageSaved("Container added.");
  }, "Unable to add the container");

  const saveBin = (next: string | null) => run(async () => {
    const payload = await api<{ path: string | null }>("/api/storage/trash-root", {
      method: "PUT",
      body: JSON.stringify({ path: next })
    });
    setBinPath(payload.path);
    setBinSaved(true);
  }, "Unable to save the Recycle Bin location");

  const saveMail = () => run(async () => {
    if (!mail) return;
    await api("/api/config/mail", { method: "PUT", body: JSON.stringify(mail) });
    setMailSaved(true);
    setTestSent(false);
  }, "Unable to save the email settings");

  const sendTest = () => run(async () => {
    await api("/api/config/mail/test", { method: "POST", body: "{}" });
    setTestSent(true);
  }, "Unable to send the test email");

  const setSignInAlerts = (on: boolean) => run(async () => {
    if (!policy) return;
    // The endpoint takes the whole policy, so the thresholds ride along unchanged —
    // this screen deliberately shows none of them.
    const payload = await api<{ policy: SecurityPolicy }>("/api/security/policy", {
      method: "PATCH",
      body: JSON.stringify({ ...policy, alertNewIpSignIn: on })
    });
    setPolicy(payload.policy);
    setAlertsSaved(true);
  }, "Unable to save the alert setting");

  const saveTheme = (next: Theme) => {
    setTheme(next);
    void run(async () => {
      await api("/api/config", { method: "PATCH", body: JSON.stringify({ defaultTheme: next }) });
    }, "Unable to save the theme");
  };

  /** Finish and Skip are the same write: the guide has been offered. */
  const leave = () => run(async () => {
    await api("/api/setup/onboarding/complete", { method: "POST", body: "{}" });
    navigate("/");
  }, "Unable to close the setup guide");

  // What a later step needs from an earlier one. Not a guess: a Recycle Bin folder must
  // sit inside a configured container, and an alert with no mail server is a promise the
  // app cannot keep.
  const storageReady = Boolean(settings?.thumbnailPathReady) && roots.length > 0;
  const mailReady = Boolean(mail?.host && mail.fromAddress);
  const lockedReason = (key: StepKey): string | null => {
    if (key === "bin" && !storageReady) return "Set up storage first — the bin has to live inside a container you have approved.";
    if (key === "alerts" && !mailReady) return "Set up email first — an alert nobody receives reads as nothing having happened.";
    return null;
  };
  const index = STEPS.findIndex((entry) => entry.key === step);

  return (
    <div className="welcome-page">
      <header className="welcome-head">
        <p className="eyebrow">Welcome, {user.displayName}</p>
        <h1>
          <span>Let's set up your library</span>
          <span className="welcome-version">isputnik.home v{APP_VERSION}</span>
        </h1>
        <p>
          A few things worth settling before anything else. Every one of them is a Control panel
          page too, so nothing here is your only chance to answer it — and you can leave at any
          point.
        </p>
      </header>

      <div className="welcome-shell">
        <aside className="welcome-rail" aria-label="Setup steps">
          {STEPS.map((entry, position) => {
            const Icon = entry.icon;
            const done = position < index;
            const locked = lockedReason(entry.key);
            // A locked step is still reachable: it explains what it will be for, which is
            // more use than a step that refuses to open and says nothing.
            return (
              <button
                type="button"
                className={[
                  "welcome-step",
                  entry.key === step ? "is-active" : "",
                  done && !locked ? "is-done" : "",
                  locked ? "is-locked" : ""
                ].filter(Boolean).join(" ")}
                aria-current={entry.key === step ? "step" : undefined}
                key={entry.key}
                onClick={() => setStep(entry.key)}
              >
                <span className="welcome-step-dot" aria-hidden="true">
                  {locked ? <Lock size={14} /> : done ? <Check size={14} /> : <Icon size={16} />}
                </span>
                <span className="welcome-step-copy">
                  <strong>{entry.title}</strong>
                  <span>{locked ? "Needs the step above" : entry.note}</span>
                </span>
              </button>
            );
          })}
        </aside>

        <section className="welcome-body">
          {error && <MessageBox tone="error" title="That didn't work">{error}</MessageBox>}

          {step === "storage" && (
            <>
              <h2>Where files live</h2>
              <p>
                Two folders, and nothing else works without them: somewhere to keep the covers and
                previews the app generates, and at least one folder your libraries are allowed to read.
              </p>
              <p className="welcome-note">
                Both are paths as the <strong>server</strong> sees them. In Docker that means the path
                inside the container — <code>/media</code>, not <code>/mnt/user/media</code>.
              </p>

              <div className="welcome-field-row">
                <Field label="Thumbnail storage" value={thumbnailPath} onChange={setThumbnailPath} />
                <Button variant="secondary" disabled={busy || !thumbnailPath.trim()} onClick={() => void saveThumbnailPath()}>
                  {settings?.thumbnailPathReady ? "Change" : "Save"}
                </Button>
              </div>
              {settings?.thumbnailPathReady
                ? <p className="setting-status ready">Ready</p>
                : settings?.thumbnailPathError && <p className="setting-status needs-attention">{settings.thumbnailPathError}</p>}

              <h3>Digital Library containers</h3>
              <p className="welcome-note">
                A container is a folder you are approving. Libraries can then use it or anything
                inside it — a mistyped path can't wander off into the rest of the disk.
              </p>
              {roots.length > 0 && (
                <ul className="welcome-list">
                  {roots.map((root) => (
                    <li key={root.id}><strong>{root.name}</strong><span>{root.path}</span></li>
                  ))}
                </ul>
              )}
              <div className="welcome-field-row">
                <Field label="Name" value={rootName} onChange={setRootName} />
                <Field label="Path" value={rootPath} onChange={setRootPath} />
                <Button variant="secondary" disabled={busy || !rootPath.trim() || !rootName.trim()} onClick={() => void addContainer()}>
                  Add
                </Button>
              </div>
              {storageSaved && <MessageBox tone="success" title="Saved">{storageSaved}</MessageBox>}
            </>
          )}

          {step === "bin" && (
            <>
              <h2>Where deleted files wait</h2>
              <p>
                Deleting from the app moves files to the Recycle Bin rather than erasing them.
                By default each library keeps its own hidden <code>.trash</code> folder — instant
                to delete into, since nothing leaves the disk it was already on.
              </p>
              <p className="welcome-note">
                One folder for everything is worth choosing if anything else reads the same
                shares. Immich, a backup job or a sync client will happily index a library's
                <code>.trash</code> and go on showing everything you deleted as though it were
                still there.
              </p>

              {lockedReason("bin") ? (
                <MessageBox tone="info" title="Storage first">{lockedReason("bin")}</MessageBox>
              ) : (
                <>
                  <div className="field source-folder-field">
                    <span>Recycle Bin folder</span>
                    <div className="source-folder-control">
                      <Folder size={19} aria-hidden="true" />
                      <span>{binPath || "Each library's own .trash folder"}</span>
                      <Button
                        variant="secondary"
                        compact
                        disabled={busy || !binEditable}
                        title={binEditable ? undefined : "The bin already holds items — empty it before moving it"}
                        onClick={() => { setError(""); setBinPickerOpen(true); }}
                      >
                        Browse
                      </Button>
                      {binPath && (
                        <Button variant="text" disabled={busy || !binEditable} onClick={() => void saveBin(null)}>
                          Clear
                        </Button>
                      )}
                    </div>
                  </div>
                  <p className="welcome-note">
                    Best decided now: once anything is in the bin, the location can only change
                    while it is completely empty. Keep it on the same disk as your libraries —
                    across disks, deleting copies every byte instead of being a rename.
                  </p>
                  {binSaved && <MessageBox tone="success" title="Saved">Recycle Bin location updated.</MessageBox>}
                </>
              )}
            </>
          )}

          {step === "alerts" && (
            <>
              <h2>Tell me about sign-ins</h2>
              <p>
                The app can write to you when an account signs in from a network it has not seen
                before — the earliest sign that a password has been guessed, phished or reused.
              </p>

              {lockedReason("alerts") ? (
                <MessageBox tone="info" title="Email first">{lockedReason("alerts")}</MessageBox>
              ) : (
                <>
                  <div className="welcome-toggle">
                    <ToggleSwitch
                      checked={Boolean(policy?.alertNewIpSignIn)}
                      disabled={busy || !policy}
                      onChange={(on) => void setSignInAlerts(on)}
                      label="Email me about sign-ins from a new network"
                    />
                  </div>
                  {!testSent && (
                    <p className="welcome-note">
                      Worth sending yourself a test on the previous step first — an alert that
                      cannot arrive reads exactly like nothing having happened.
                    </p>
                  )}
                  {alertsSaved && (
                    <MessageBox tone="success" title="Saved">
                      Change it any time in Control panel → Security.
                    </MessageBox>
                  )}
                </>
              )}
            </>
          )}

          {step === "email" && mail && (
            <>
              <h2>Email</h2>
              <p>
                Optional, and worth doing: two-factor codes, invite links, security alerts and
                Send to e-reader all travel this way. Without it they simply never arrive.
              </p>

              <div className="welcome-grid">
                <Field label="SMTP host" value={mail.host} onChange={(host) => setMail({ ...mail, host })} />
                <Field label="Port" value={String(mail.port)} onChange={(port) => setMail({ ...mail, port: Number(port) || 0 })} />
                <Field label="Username" value={mail.username} onChange={(username) => setMail({ ...mail, username })} />
                <Field
                  label="Password"
                  type="password"
                  value={password}
                  onChange={setPassword}
                  required={false}
                  placeholder={mail.hasPassword ? "Stored — leave blank to keep it" : ""}
                />
                <Field label="From address" value={mail.fromAddress} onChange={(fromAddress) => setMail({ ...mail, fromAddress })} />
                <Field label="From name" value={mail.fromName} onChange={(fromName) => setMail({ ...mail, fromName })} />
              </div>
              <label className="welcome-toggle">
                <ToggleSwitch checked={mail.secure} onChange={(secure) => setMail({ ...mail, secure })} label="Use TLS on connect (port 465)" />
              </label>

              <div className="welcome-actions-inline">
                <Button variant="secondary" disabled={busy} onClick={() => void saveMail()}>
                  {busy ? "Saving…" : "Save"}
                </Button>
                <Button variant="secondary" disabled={busy || !mailReady} onClick={() => void sendTest()}>
                  Send a test to {user.email}
                </Button>
              </div>
              {mailSaved && !testSent && <MessageBox tone="info" title="Saved">Send yourself a test to prove it works.</MessageBox>}

              {testSent && (
                <MessageBox tone="success" title="Test email sent">
                  Check {user.email}. If it arrived, email works — and the next step can put it
                  to use.
                </MessageBox>
              )}
            </>
          )}

          {step === "theme" && (
            <>
              <h2>Appearance</h2>
              <p>
                The look the sign-in screen uses, and what a new member starts with. Everyone can
                change their own afterwards in their profile.
              </p>
              <ThemePicker value={theme} onChange={saveTheme} disabled={busy} />
            </>
          )}
        </section>
      </div>

      {binPickerOpen && (
        <FolderPickerModal
          title="Select the Recycle Bin folder"
          intro="Choose a folder inside an approved container — one outside every library, since anything inside a library is scanned."
          storageRoots={roots}
          confirmLabel="Use this folder"
          onPick={({ absolutePath }) => {
            setBinPickerOpen(false);
            void saveBin(absolutePath);
          }}
          onClose={() => setBinPickerOpen(false)}
          onError={setError}
        />
      )}

      <div className="welcome-actions">
        {index > 0 && (
          <Button variant="secondary" disabled={busy} onClick={() => setStep(STEPS[index - 1].key)}>
            <ArrowLeft size={16} aria-hidden="true" />
            <span>Back</span>
          </Button>
        )}
        <Button variant="text" disabled={busy} onClick={() => void leave()}>Skip for now</Button>
        <span className="welcome-actions-spacer" aria-hidden="true" />
        {index < STEPS.length - 1 ? (
          <Button variant="primary" disabled={busy} onClick={() => setStep(STEPS[index + 1].key)}>
            <span>Next</span>
            <ArrowRight size={16} aria-hidden="true" />
          </Button>
        ) : (
          <Button variant="primary" disabled={busy} onClick={() => void leave()}>
            <ShieldCheck size={16} aria-hidden="true" />
            <span>{storageReady ? "Finish" : "Finish anyway"}</span>
          </Button>
        )}
      </div>
    </div>
  );
}
