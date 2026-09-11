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
import { Trans, useTranslation } from "react-i18next";
import {
  ArrowLeft, ArrowRight, Check, DatabaseBackup, Folder, HardDrive, Images, Lock, Mail, Palette,
  ShieldCheck, Trash2
} from "lucide-react";
import { versionLabel } from "../shared/appVersion";
import { api, type PublicUser } from "../api";
import { Button } from "../shared/Button";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { Field } from "../shared/Field";
import { MessageBox } from "../shared/MessageBox";
import { ThemePicker, type Theme } from "../shared/ThemePicker";
import { ToggleSwitch } from "../shared/ToggleSwitch";
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

/** What this step edits: the full-backup scheduled job (on/off, daily at a clock
 *  time) and the keep-count from `/api/backups`. Since 3.89.0 the schedule is one of
 *  the Scheduled jobs, so the two are read and written separately. */
interface BackupSettings {
  enabled: boolean;
  time: string;
  dayOfWeek: number;
  dayOfMonth: number;
  retention: number;
}

interface BackupJobView {
  key: string;
  enabled: boolean;
  time: string;
  dayOfWeek: number;
  dayOfMonth: number;
}

const BACKUP_JOB = "backup_full";

function backupStep(jobs: BackupJobView[] | null, settings: { retention: number } | null): BackupSettings | null {
  const job = jobs?.find((entry) => entry.key === BACKUP_JOB);
  if (!job || !settings) return null;
  return { enabled: job.enabled, time: job.time, dayOfWeek: job.dayOfWeek, dayOfMonth: job.dayOfMonth, retention: settings.retention };
}

type StepKey = "storage" | "bin" | "gallery" | "backup" | "email" | "alerts" | "theme";

/** The App storage view, as far as this page needs it (docs/app-storage-plan.md). */
interface AppStorageView {
  path: string | null;
  rooms: { room: string; mode: "app" | "own" | "off"; appPath: string | null; library: { id: string; name: string } | null; counts: { itemsInBin?: number } }[];
}

// Two of these depend on the step before them, and say so rather than being hidden: the
// Recycle Bin needs a container to live in, and an alert needs a way to reach you. A
// step you cannot use yet still explains what it is for, and where to come back to.
//
// Backups sit third, beside the bin: both are about getting something back after it has
// gone, and both are worth answering before there is anything to lose. It depends on
// nothing — the archive is written inside the app's own data folder, not into a
// container you have to approve first.
//
// The App files step sits after the bin: the two libraries it offers are
// made inside App storage, which the storage step chose.
const STEP_ORDER: StepKey[] = ["storage", "bin", "gallery", "backup", "email", "alerts", "theme"];

const STEP_ICONS: Record<StepKey, typeof HardDrive> = {
  storage: HardDrive,
  bin: Trash2,
  gallery: Images,
  backup: DatabaseBackup,
  email: Mail,
  alerts: ShieldCheck,
  theme: Palette
};

export function WelcomePage({ user, onDone }: {
  user: PublicUser;
  /** Leaving is the App's business, not this page's: it holds the session, and the
   *  session is what decides whether the guide opens. Navigating on our own sent us
   *  to a Home that still believed the guide was pending and bounced us straight
   *  back — a loop that looked exactly like a button doing nothing. */
  onDone: () => void;
}) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const STEPS = STEP_ORDER.map((key) => ({
    key,
    title: t(`welcome.steps.${key}.title`),
    note: t(`welcome.steps.${key}.note`),
    icon: STEP_ICONS[key]
  }));

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
  // App storage: pick → confirm → save. The thumbnail field stays as the "on my
  // own" alternative, folded away until asked for.
  const [appStorage, setAppStorage] = useState<AppStorageView | null>(null);
  const [appPickerOpen, setAppPickerOpen] = useState(false);
  const [appPathPending, setAppPathPending] = useState<string | null>(null);
  const [ownFoldersOpen, setOwnFoldersOpen] = useState(false);

  // Recycle Bin
  const [binPath, setBinPath] = useState<string | null>(null);
  const [binEditable, setBinEditable] = useState(true);
  const [binPickerOpen, setBinPickerOpen] = useState(false);
  const [binSaved, setBinSaved] = useState(false);
  const [binAppPending, setBinAppPending] = useState(false);

  // App files / Photo Inbox: one confirmed click each.
  const [galleryPending, setGalleryPending] = useState<"house" | "inbox" | null>(null);
  const [gallerySaved, setGallerySaved] = useState("");

  // Backups
  const [backup, setBackup] = useState<BackupSettings | null>(null);
  const [backupPath, setBackupPath] = useState("");
  const [backupSaved, setBackupSaved] = useState("");

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
    // One read per step, once, in parallel: this page is only ever opened by an admin,
    // and every step needs to open on what is already configured rather than on blanks.
    Promise.all([
      api<{ settings: LibrarySettings }>("/api/library/settings").catch(() => null),
      api<{ roots: StorageRoot[] }>("/api/storage/roots").catch(() => null),
      api<{ mail: MailSettings }>("/api/config/mail").catch(() => null),
      api<{ config: { defaultTheme: Theme } }>("/api/config").catch(() => null),
      api<{ policy: SecurityPolicy }>("/api/security").catch(() => null),
      api<{ path: string | null; editable: boolean }>("/api/storage/trash-root").catch(() => null),
      api<{ settings: { retention: number }; backupPath: string }>("/api/backups").catch(() => null),
      api<AppStorageView>("/api/storage/app-storage").catch(() => null),
      api<{ jobs: BackupJobView[] }>("/api/scheduled-jobs").catch(() => null)
    ]).then(([librarySettings, rootList, mailPayload, config, security, bin, backups, storage, jobs]) => {
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
      if (backups) {
        setBackup(backupStep(jobs?.jobs ?? null, backups.settings));
        setBackupPath(backups.backupPath);
      }
      if (storage) setAppStorage(storage);
    });
  }, []);

  /** Re-read what App storage decides for the other steps: the thumbnail folder,
   *  the bin, the backups path all follow it. */
  const reloadStorage = async () => {
    const [librarySettings, bin, storage, backups] = await Promise.all([
      api<{ settings: LibrarySettings }>("/api/library/settings").catch(() => null),
      api<{ path: string | null; editable: boolean }>("/api/storage/trash-root").catch(() => null),
      api<AppStorageView>("/api/storage/app-storage").catch(() => null),
      api<{ settings: { retention: number }; backupPath: string }>("/api/backups").catch(() => null)
    ]);
    if (librarySettings) {
      setSettings(librarySettings.settings);
      setThumbnailPath(librarySettings.settings.thumbnailPath);
    }
    if (bin) {
      setBinPath(bin.path);
      setBinEditable(bin.editable);
    }
    if (storage) setAppStorage(storage);
    if (backups) setBackupPath(backups.backupPath);
  };

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
    setStorageSaved(t("welcome.thumbnailSaved"));
  }, t("welcome.thumbnailSaveFailed"));

  const saveAppStorage = () => run(async () => {
    if (!appPathPending) return;
    await api("/api/storage/app-storage", { method: "PUT", body: JSON.stringify({ path: appPathPending }) });
    setAppPathPending(null);
    await reloadStorage();
    setStorageSaved(t("welcome.appStorageSaved"));
  }, t("welcome.appStorageSaveFailed"));

  const switchRoom = (room: "trash" | "house" | "inbox", whenFailed: string) => run(async () => {
    await api(`/api/storage/app-storage/rooms/${room}`, { method: "PUT", body: JSON.stringify({ mode: "app" }) });
    await reloadStorage();
    if (room === "trash") setBinSaved(true);
    else setGallerySaved(t("welcome.gallerySaved"));
  }, whenFailed);

  const addContainer = () => run(async () => {
    await api("/api/storage/roots", {
      method: "POST",
      body: JSON.stringify({ name: rootName, path: rootPath })
    });
    const payload = await api<{ roots: StorageRoot[] }>("/api/storage/roots");
    setRoots(payload.roots);
    setRootPath("");
    setStorageSaved(t("welcome.containerAdded"));
  }, t("welcome.containerAddFailed"));

  const saveBin = (next: string | null) => run(async () => {
    const payload = await api<{ path: string | null }>("/api/storage/trash-root", {
      method: "PUT",
      body: JSON.stringify({ path: next })
    });
    setBinPath(payload.path);
    setBinSaved(true);
  }, t("welcome.binSaveFailed"));

  /** "Once a day" is the full-backup job set to daily: the job endpoint takes the
   *  whole schedule, so the anchor days it does not use here are carried along as
   *  they are. The keep-count is the Backup page's own setting. */
  const saveBackup = (patch: Partial<BackupSettings>) => run(async () => {
    if (!backup) return;
    const next = { ...backup, ...patch };
    await api(`/api/scheduled-jobs/${BACKUP_JOB}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: next.enabled, frequency: "daily", time: next.time, dayOfWeek: next.dayOfWeek, dayOfMonth: next.dayOfMonth })
    });
    if (next.retention !== backup.retention) {
      await api("/api/backups/settings", { method: "PATCH", body: JSON.stringify({ retention: next.retention }) });
    }
    setBackup(next);
    setBackupSaved(next.enabled
      ? t("welcome.backupSavedDaily", { time: next.time, count: next.retention })
      : t("welcome.backupSavedOff"));
  }, t("welcome.backupSaveFailed"));

  const saveMail = () => run(async () => {
    if (!mail) return;
    // `hasPassword` is a read-only flag the server sends; the password itself is only
    // ever sent when it has been typed into, since blank means "keep the stored one".
    const { hasPassword, ...settings } = mail;
    const payload = await api<{ mail: MailSettings }>("/api/config/mail", {
      method: "PUT",
      body: JSON.stringify(password ? { ...settings, password } : settings)
    });
    setMail(payload.mail);
    setPassword("");
    setMailSaved(true);
    setTestSent(false);
  }, t("welcome.mailSaveFailed"));

  const sendTest = () => run(async () => {
    await api("/api/config/mail/test", { method: "POST", body: "{}" });
    setTestSent(true);
  }, t("welcome.testSendFailed"));

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
  }, t("welcome.alertsSaveFailed"));

  const saveTheme = (next: Theme) => {
    setTheme(next);
    void run(async () => {
      await api("/api/config", { method: "PATCH", body: JSON.stringify({ defaultTheme: next }) });
    }, t("welcome.themeSaveFailed"));
  };

  /** Finish and Skip are the same write: the guide has been offered.
   *
   *  Leaving happens either way. "Let me out" is the ask, and a server that cannot
   *  record it must not turn the guide into a room with no door — the honest
   *  consequence of a failed write is simply that the guide offers itself once more
   *  on the next sign-in, which is what the unset flag already means. */
  const leave = async () => {
    setBusy(true);
    setError("");
    try {
      await api("/api/setup/onboarding/complete", { method: "POST", body: "{}" });
    } catch {
      /* the flag stays unset; the guide will ask again */
    } finally {
      setBusy(false);
      onDone();
    }
  };

  // What a later step needs from an earlier one. Not a guess: a Recycle Bin folder must
  // sit inside a configured container, and an alert with no mail server is a promise the
  // app cannot keep.
  const storageReady = Boolean(settings?.thumbnailPathReady) && roots.length > 0;
  const mailReady = Boolean(mail?.host && mail.fromAddress);
  const appStorageSet = Boolean(appStorage?.path);
  const lockedReason = (key: StepKey): string | null => {
    if (key === "bin" && !storageReady) return t("welcome.lockedBinBody");
    if (key === "gallery" && !appStorageSet) return t("welcome.lockedGalleryBody");
    if (key === "alerts" && !mailReady) return t("welcome.lockedAlertsBody");
    return null;
  };
  const room = (name: string) => appStorage?.rooms.find((entry) => entry.room === name) ?? null;
  const roomLabel: Record<string, string> = {
    trash: t("controlAdmin:storage.roomTrash"),
    thumbnails: t("controlAdmin:storage.roomThumbnails"),
    renders: t("controlAdmin:storage.roomRenders"),
    inbox: t("controlAdmin:storage.roomInbox"),
    house: t("controlAdmin:storage.roomHouse"),
    backups: t("controlAdmin:storage.roomBackups")
  };
  const roomsInApp = (appStorage?.rooms ?? []).filter((entry) => entry.mode === "app").map((entry) => roomLabel[entry.room] ?? entry.room);
  const binUsesApp = room("trash")?.mode === "app";
  const appRoomPath = (name: string) => room(name)?.appPath ?? "";
  const index = STEPS.findIndex((entry) => entry.key === step);

  return (
    <div className="welcome-page">
      <header className="welcome-head">
        <p className="eyebrow">{t("welcome.greeting", { name: user.displayName })}</p>
        <h1>
          <span>{t("welcome.heading")}</span>
          <span className="welcome-version">isputnik.home {versionLabel(t)}</span>
        </h1>
        <p>
          {t("welcome.intro")}
        </p>
      </header>

      <div className="welcome-shell">
        <aside className="welcome-rail" aria-label={t("welcome.railLabel")}>
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
                  <span>{locked ? t("welcome.lockedNote") : entry.note}</span>
                </span>
              </button>
            );
          })}
        </aside>

        <section className="welcome-body">
          {error && <MessageBox tone="error" title={t("welcome.genericError")}>{error}</MessageBox>}

          {step === "storage" && (
            <>
              <h2>{t("welcome.storageHeading")}</h2>
              <p>
                {t("welcome.storageIntro")}
              </p>
              <p className="welcome-note">
                <Trans i18nKey="welcome.storagePathNote" components={{ strong: <strong />, code: <code /> }} />
              </p>

              <h3>{t("welcome.containersHeading")}</h3>
              <p className="welcome-note">
                {t("welcome.containersNote")}
              </p>
              {roots.length > 0 && (
                <ul className="welcome-list">
                  {roots.map((root) => (
                    <li key={root.id}><strong>{root.name}</strong><span>{root.path}</span></li>
                  ))}
                </ul>
              )}
              <div className="welcome-field-row">
                <Field label={t("welcome.containerName")} value={rootName} onChange={setRootName} />
                <Field label={t("welcome.containerPath")} value={rootPath} onChange={setRootPath} />
                <Button variant="secondary" disabled={busy || !rootPath.trim() || !rootName.trim()} onClick={() => void addContainer()}>
                  {t("welcome.add")}
                </Button>
              </div>

              <h3>{t("welcome.appStorageHeading")}</h3>
              <p className="welcome-note">
                {t("welcome.appStorageNote")}
              </p>
              <div className="field source-folder-field">
                <span>{t("welcome.appStorageHeading")}</span>
                <div className="source-folder-control">
                  <Folder size={19} aria-hidden="true" />
                  <span>{appStorage?.path || t("welcome.appStorageNotSet")}</span>
                  <Button
                    variant="secondary"
                    compact
                    disabled={busy || roots.length === 0}
                    title={roots.length === 0 ? t("welcome.appStorageNeedsContainer") : undefined}
                    onClick={() => { setError(""); setAppPickerOpen(true); }}
                  >
                    {appStorage?.path ? t("welcome.change") : t("welcome.appStorageBrowse")}
                  </Button>
                </div>
              </div>
              {appStorage?.path && roomsInApp.length > 0 && (
                <p className="setting-status ready">{t("welcome.appStorageRooms", { rooms: roomsInApp.join(", ") })}</p>
              )}

              {/* The thumbnail folder on its own: today's step, folded away. Thumbnails are
                  the one room that must exist, so this is the only alternative the guide
                  has to offer; everything else is a row on the Storage page. */}
              <Button variant="text" disabled={busy} onClick={() => setOwnFoldersOpen((open) => !open)}>
                {t("welcome.ownFoldersToggle")}
              </Button>
              {(ownFoldersOpen || (!appStorage?.path && Boolean(settings?.thumbnailPath))) && (
                <>
                  <p className="welcome-note">{t("welcome.ownFoldersNote")}</p>
                  <div className="welcome-field-row">
                    <Field label={t("welcome.thumbnailLabel")} value={thumbnailPath} onChange={setThumbnailPath} />
                    <Button variant="secondary" disabled={busy || !thumbnailPath.trim()} onClick={() => void saveThumbnailPath()}>
                      {settings?.thumbnailPathReady ? t("welcome.change") : t("welcome.save")}
                    </Button>
                  </div>
                  {settings?.thumbnailPathReady
                    ? <p className="setting-status ready">{t("welcome.ready")}</p>
                    : settings?.thumbnailPathError && <p className="setting-status needs-attention">{settings.thumbnailPathError}</p>}
                </>
              )}
              {storageSaved && <MessageBox tone="success" title={t("welcome.savedTitle")}>{storageSaved}</MessageBox>}
            </>
          )}

          {step === "bin" && (
            <>
              <h2>{t("welcome.binHeading")}</h2>
              <p>
                <Trans i18nKey="welcome.binIntro" components={{ code: <code /> }} />
              </p>
              <p className="welcome-note">
                <Trans i18nKey="welcome.binNote" components={{ code: <code /> }} />
              </p>

              {lockedReason("bin") ? (
                <MessageBox tone="info" title={t("welcome.storageFirstTitle")}>{lockedReason("bin")}</MessageBox>
              ) : (
                <>
                  <div className="field source-folder-field">
                    <span>{t("welcome.binFieldLabel")}</span>
                    <div className="source-folder-control">
                      <Folder size={19} aria-hidden="true" />
                      <span>{binPath || t("welcome.binDefault")}</span>
                      {binUsesApp && <span className="setting-status ready">{t("welcome.binUsingApp")}</span>}
                      {appStorageSet && !binUsesApp && (
                        <Button
                          variant="secondary"
                          compact
                          disabled={busy || !binEditable}
                          title={binEditable ? undefined : t("welcome.binBrowseLocked")}
                          onClick={() => { setError(""); setBinAppPending(true); }}
                        >
                          {t("welcome.binUseApp")}
                        </Button>
                      )}
                      <Button
                        variant="secondary"
                        compact
                        disabled={busy || !binEditable}
                        title={binEditable ? undefined : t("welcome.binBrowseLocked")}
                        onClick={() => { setError(""); setBinPickerOpen(true); }}
                      >
                        {t("welcome.binBrowse")}
                      </Button>
                      {binPath && (
                        <Button variant="text" disabled={busy || !binEditable} onClick={() => void saveBin(null)}>
                          {t("welcome.binClear")}
                        </Button>
                      )}
                    </div>
                  </div>
                  <p className="welcome-note">
                    {t("welcome.binPathNote")}
                  </p>
                  {binSaved && <MessageBox tone="success" title={t("welcome.savedTitle")}>{t("welcome.binSaved")}</MessageBox>}
                </>
              )}
            </>
          )}

          {step === "gallery" && (
            <>
              <h2>{t("welcome.galleryHeading")}</h2>
              <p>
                {t("welcome.galleryIntro")}
              </p>
              {lockedReason("gallery") ? (
                <MessageBox tone="info" title={t("welcome.appStorageFirstTitle")}>{lockedReason("gallery")}</MessageBox>
              ) : (
                <>
                  {(["house", "inbox"] as const).map((name) => {
                    const view = room(name);
                    return (
                      <div key={name}>
                        <h3>{name === "house" ? t("welcome.galleryHouseLabel") : t("welcome.galleryInboxLabel")}</h3>
                        <p className="welcome-note">{name === "house" ? t("welcome.galleryHouseNote") : t("welcome.galleryInboxNote")}</p>
                        <div className="field source-folder-field">
                          <span>{t("welcome.galleryLibraryLabel")}</span>
                          <div className="source-folder-control">
                            <Images size={19} aria-hidden="true" />
                            <span>{view?.library?.name ?? t("welcome.galleryNotSet")}</span>
                            {view?.mode === "app" ? (
                              <span className="setting-status ready">{t("welcome.binUsingApp")}</span>
                            ) : (
                              <Button variant="secondary" compact disabled={busy} onClick={() => { setError(""); setGalleryPending(name); }}>
                                {t("welcome.galleryMakeInApp")}
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {gallerySaved && <MessageBox tone="success" title={t("welcome.savedTitle")}>{gallerySaved}</MessageBox>}
                </>
              )}
            </>
          )}

          {step === "backup" && (
            <>
              <h2>{t("welcome.backupHeading")}</h2>
              <p>
                {t("welcome.backupIntro")}
              </p>
              <p className="welcome-note">
                {t("welcome.backupNote")}
              </p>

              <div className="welcome-toggle">
                <ToggleSwitch
                  checked={Boolean(backup?.enabled)}
                  disabled={busy || !backup}
                  onChange={(on) => void saveBackup({ enabled: on })}
                  label={t("welcome.backupToggle")}
                />
              </div>

              {/* Only once it is on. A time and a keep-count are answers to "when" and
                  "how many", and neither question exists while the answer to "at all?"
                  is no. */}
              {backup?.enabled && (
                <div className="welcome-field-row">
                  <Field
                    label={t("welcome.backupTime")}
                    type="time"
                    value={backup.time}
                    onChange={(next) => setBackup({ ...backup, time: next })}
                  />
                  <Field
                    label={t("welcome.backupKeepLast")}
                    type="number"
                    value={String(backup.retention)}
                    onChange={(next) => setBackup({ ...backup, retention: Number(next) || 0 })}
                  />
                  <Button variant="secondary" disabled={busy} onClick={() => void saveBackup({})}>
                    {t("welcome.save")}
                  </Button>
                </div>
              )}

              {backupPath && (
                <p className="welcome-note">
                  <Trans i18nKey="welcome.backupPathNote" values={{ path: backupPath }} components={{ code: <code /> }} />
                </p>
              )}

              {backupSaved && (
                <MessageBox tone="success" title={t("welcome.savedTitle")}>
                  {backupSaved} {t("welcome.backupSavedMore")}
                </MessageBox>
              )}
            </>
          )}

          {step === "alerts" && (
            <>
              <h2>{t("welcome.alertsHeading")}</h2>
              <p>
                {t("welcome.alertsIntro")}
              </p>

              {lockedReason("alerts") ? (
                <MessageBox tone="info" title={t("welcome.emailFirstTitle")}>{lockedReason("alerts")}</MessageBox>
              ) : (
                <>
                  <div className="welcome-toggle">
                    <ToggleSwitch
                      checked={Boolean(policy?.alertNewIpSignIn)}
                      disabled={busy || !policy}
                      onChange={(on) => void setSignInAlerts(on)}
                      label={t("welcome.alertsToggle")}
                    />
                  </div>
                  {!testSent && (
                    <p className="welcome-note">
                      {t("welcome.alertsTestNote")}
                    </p>
                  )}
                  {alertsSaved && (
                    <MessageBox tone="success" title={t("welcome.savedTitle")}>
                      {t("welcome.alertsSavedBody")}
                    </MessageBox>
                  )}
                </>
              )}
            </>
          )}

          {step === "email" && mail && (
            <>
              <h2>{t("welcome.emailHeading")}</h2>
              <p>
                {t("welcome.emailIntro")}
              </p>

              <div className="welcome-grid">
                <Field label={t("welcome.smtpHost")} value={mail.host} onChange={(host) => setMail({ ...mail, host })} />
                <Field label={t("welcome.port")} value={String(mail.port)} onChange={(port) => setMail({ ...mail, port: Number(port) || 0 })} />
                <Field label={t("welcome.username")} value={mail.username} onChange={(username) => setMail({ ...mail, username })} />
                <Field
                  label={t("common.password")}
                  type="password"
                  value={password}
                  onChange={setPassword}
                  required={false}
                  placeholder={mail.hasPassword ? t("welcome.passwordStored") : ""}
                />
                <Field label={t("welcome.fromAddress")} value={mail.fromAddress} onChange={(fromAddress) => setMail({ ...mail, fromAddress })} />
                <Field label={t("welcome.fromName")} value={mail.fromName} onChange={(fromName) => setMail({ ...mail, fromName })} />
              </div>
              <label className="welcome-toggle">
                <ToggleSwitch checked={mail.secure} onChange={(secure) => setMail({ ...mail, secure })} label={t("welcome.useTls")} />
              </label>

              <div className="welcome-actions-inline">
                <Button variant="secondary" disabled={busy} onClick={() => void saveMail()}>
                  {busy ? t("profile.account.saving") : t("welcome.save")}
                </Button>
                <Button variant="secondary" disabled={busy || !mailReady} onClick={() => void sendTest()}>
                  {t("welcome.sendTestTo", { email: user.email })}
                </Button>
              </div>
              {mailSaved && !testSent && <MessageBox tone="info" title={t("welcome.savedTitle")}>{t("welcome.sendTestHint")}</MessageBox>}

              {testSent && (
                <MessageBox tone="success" title={t("welcome.testSentTitle")}>
                  {t("welcome.testSentBody", { email: user.email })}
                </MessageBox>
              )}
            </>
          )}

          {step === "theme" && (
            <>
              <h2>{t("welcome.steps.theme.title")}</h2>
              <p>
                {t("welcome.themeIntro")}
              </p>
              <ThemePicker value={theme} onChange={saveTheme} disabled={busy} />
            </>
          )}
        </section>
      </div>

      {appPickerOpen && (
        <FolderPickerModal
          title={t("controlAdmin:storage.pickAppTitle")}
          intro={t("controlAdmin:storage.pickAppIntro")}
          storageRoots={roots}
          confirmLabel={t("controlAdmin:storage.useThisFolder")}
          onPick={({ absolutePath }) => {
            setAppPickerOpen(false);
            setAppPathPending(absolutePath);
          }}
          onClose={() => setAppPickerOpen(false)}
          onError={setError}
        />
      )}

      {appPathPending && (
        <ConfirmDialog
          title={t("controlAdmin:storage.confirmAppTitle", { path: appPathPending })}
          confirmLabel={t("controlAdmin:storage.confirmAppLabel")}
          busyLabel={t("controlAdmin:ui.saving")}
          busy={busy}
          onConfirm={() => void saveAppStorage()}
          onCancel={() => setAppPathPending(null)}
        >
          {t("controlAdmin:storage.confirmAppBody")}
        </ConfirmDialog>
      )}

      {binAppPending && (
        <ConfirmDialog
          title={t("controlAdmin:storage.confirmTrashAppTitle", { path: appRoomPath("trash") })}
          confirmLabel={t("controlAdmin:storage.confirmTrashLabel")}
          busyLabel={t("controlAdmin:ui.saving")}
          busy={busy}
          onConfirm={() => { void switchRoom("trash", t("welcome.binSaveFailed")).then(() => setBinAppPending(false)); }}
          onCancel={() => setBinAppPending(false)}
        >
          {t("controlAdmin:storage.confirmTrashBody", { count: room("trash")?.counts.itemsInBin ?? 0 })}
        </ConfirmDialog>
      )}

      {galleryPending && (
        <ConfirmDialog
          title={galleryPending === "house"
            ? t("controlAdmin:storage.confirmHouseAppTitle", { path: appRoomPath("house") })
            : t("controlAdmin:storage.confirmInboxAppTitle", { path: appRoomPath("inbox") })}
          confirmLabel={galleryPending === "house" ? t("controlAdmin:storage.confirmHouseAppLabel") : t("controlAdmin:storage.confirmInboxAppLabel")}
          busyLabel={t("controlAdmin:ui.saving")}
          busy={busy}
          onConfirm={() => { const which = galleryPending; void switchRoom(which, t("welcome.gallerySaveFailed")).then(() => setGalleryPending(null)); }}
          onCancel={() => setGalleryPending(null)}
        >
          {galleryPending === "house" ? t("controlAdmin:storage.confirmHouseAppBody") : t("controlAdmin:storage.confirmInboxAppBody")}
        </ConfirmDialog>
      )}

      {binPickerOpen && (
        <FolderPickerModal
          title={t("welcome.binPickerTitle")}
          intro={t("welcome.binPickerIntro")}
          storageRoots={roots}
          confirmLabel={t("welcome.binPickerConfirm")}
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
            <span>{t("welcome.back")}</span>
          </Button>
        )}
        <Button variant="text" disabled={busy} onClick={() => void leave()}>{t("welcome.skip")}</Button>
        <span className="welcome-actions-spacer" aria-hidden="true" />
        {index < STEPS.length - 1 ? (
          <Button variant="primary" disabled={busy} onClick={() => setStep(STEPS[index + 1].key)}>
            <span>{t("welcome.next")}</span>
            <ArrowRight size={16} aria-hidden="true" />
          </Button>
        ) : (
          <Button variant="primary" disabled={busy} onClick={() => void leave()}>
            <ShieldCheck size={16} aria-hidden="true" />
            <span>{storageReady ? t("welcome.finish") : t("welcome.finishAnyway")}</span>
          </Button>
        )}
      </div>
    </div>
  );
}
