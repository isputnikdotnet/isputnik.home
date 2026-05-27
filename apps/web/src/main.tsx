import React, { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Home,
  Info,
  LogOut,
  Monitor,
  Moon,
  Settings,
  Sun,
  UserPlus,
  UserRound,
  XCircle
} from "lucide-react";
import { api, type PublicUser } from "./api";
import "./styles.css";

type Route =
  | { name: "install" }
  | { name: "login" }
  | { name: "home" }
  | { name: "control"; section: ControlSection }
  | { name: "about" }
  | { name: "profile" }
  | { name: "invite"; token: string };

type ControlSection = "users" | "invites" | "sessions" | "logs" | "status" | "about";

interface SessionState {
  loading: boolean;
  requiresSetup: boolean;
  user: PublicUser | null;
}

interface ManagedInvite {
  id: string;
  url: string | null;
  role: "admin" | "member";
  status: "active" | "expired" | "used";
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  createdByName: string;
  usedByName: string | null;
}

interface ManagedUser extends PublicUser {
  activeSessions: number;
}

interface ManagedSession {
  id: string;
  userId: string;
  displayName: string;
  email: string;
  createdAt: string;
  expiresAt: string;
  lastSeen: string;
  deviceName: string | null;
  ipAddress: string | null;
  current: boolean;
}

interface LogEvent {
  id: string;
  event: string;
  detail: string;
  ipAddress: string | null;
  createdAt: string;
  actorName: string | null;
}

interface SystemStatus {
  health: string;
  databaseBytes: number;
  users: number;
  activeSessions: number;
  activeInvites: number;
  logEntries: number;
  uptimeSeconds: number;
  generatedAt: string;
}

interface AboutInfo {
  name: string;
  version: string;
  description: string;
  runtime: string;
  database: string;
  server: string;
  frontend: string;
  versionUpdates: {
    version: string;
    label: string;
    changes: string[];
  }[];
}

function getRoute(): Route {
  const path = window.location.pathname;
  const inviteMatch = path.match(/^\/invite\/([^/]+)$/);

  if (inviteMatch) {
    return { name: "invite", token: inviteMatch[1] };
  }

  if (path === "/install") {
    return { name: "install" };
  }

  if (path === "/login") {
    return { name: "login" };
  }

  if (["/admin", "/control"].includes(path)) {
    return { name: "control", section: "status" };
  }

  if (path === "/control/users") {
    return { name: "control", section: "users" };
  }

  if (path === "/control/invites") {
    return { name: "control", section: "invites" };
  }

  if (path === "/control/sessions") {
    return { name: "control", section: "sessions" };
  }

  if (["/control/activity", "/control/logs"].includes(path)) {
    return { name: "control", section: "logs" };
  }

  if (path === "/control/status") {
    return { name: "control", section: "status" };
  }

  if (path === "/control/about") {
    return { name: "control", section: "about" };
  }

  if (path === "/profile") {
    return { name: "profile" };
  }

  if (path === "/about") {
    return { name: "about" };
  }

  return { name: "home" };
}

function navigate(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function followRoute(event: React.MouseEvent<HTMLAnchorElement>, path: string) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }

  event.preventDefault();
  navigate(path);
}

function useRoute() {
  const [route, setRoute] = useState(getRoute);

  useEffect(() => {
    const onPop = () => setRoute(getRoute());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  return route;
}

function App() {
  const route = useRoute();
  const [session, setSession] = useState<SessionState>({
    loading: true,
    requiresSetup: false,
    user: null
  });

  const refreshSession = useCallback(async () => {
    const setup = await api<{ requiresSetup: boolean }>("/api/setup/status");
    if (setup.requiresSetup) {
      setSession({ loading: false, requiresSetup: true, user: null });
      return;
    }

    const me = await api<{ user: PublicUser }>("/api/auth/me").catch(() => ({ user: null as unknown as PublicUser }));
    setSession({ loading: false, requiresSetup: false, user: me.user });
  }, []);

  useEffect(() => {
    refreshSession().catch(() => setSession({ loading: false, requiresSetup: false, user: null }));
  }, [refreshSession]);

  useEffect(() => {
    const preferred = session.user?.theme ?? "dark";
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const theme = preferred === "system" ? (mediaQuery.matches ? "dark" : "light") : preferred;
      document.documentElement.dataset.theme = theme;
    };

    applyTheme();
    mediaQuery.addEventListener("change", applyTheme);
    return () => mediaQuery.removeEventListener("change", applyTheme);
  }, [session.user?.theme]);

  useEffect(() => {
    if (session.loading) {
      return;
    }

    if (session.requiresSetup && route.name !== "install") {
      navigate("/install");
      return;
    }

    if (!session.requiresSetup && route.name === "install") {
      navigate(session.user ? "/" : "/login");
      return;
    }

    if (!session.requiresSetup && !session.user && !["login", "invite"].includes(route.name)) {
      navigate("/login");
      return;
    }

    if (session.user && route.name === "control" && session.user.role !== "admin") {
      navigate("/");
    }
  }, [route.name, session]);

  const logout = async () => {
    await api("/api/auth/logout", { method: "POST", body: "{}" }).catch(() => undefined);
    setSession((current) => ({ ...current, user: null }));
    navigate("/login");
  };

  if (session.loading) {
    return <Shell><p className="status">Loading isputnik.home...</p></Shell>;
  }

  if (route.name === "install") {
    return <InstallPage onSignedIn={refreshSession} />;
  }

  if (route.name === "invite") {
    return <InvitePage token={route.token} onSignedIn={refreshSession} />;
  }

  if (route.name === "login") {
    return <LoginPage onSignedIn={refreshSession} />;
  }

  if (!session.user) {
    return <Shell><p className="status">Preparing sign in...</p></Shell>;
  }

  if (route.name === "control") {
    return session.user.role === "admin"
      ? <ControlPanelPage section={route.section} user={session.user} logout={logout} />
      : <HomePage user={session.user} logout={logout} />;
  }

  if (route.name === "profile") {
    return (
      <ProfilePage
        user={session.user}
        logout={logout}
        onUpdated={(user) => setSession((current) => ({ ...current, user }))}
      />
    );
  }

  if (route.name === "about") {
    return <AboutPage user={session.user} logout={logout} />;
  }

  return <HomePage user={session.user} logout={logout} />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="app-shell">
      <div className="auth-scene" aria-hidden="true">
        <span className="auth-orbit auth-orbit-a"></span>
        <span className="auth-orbit auth-orbit-b"></span>
        <span className="auth-orbit auth-orbit-c"></span>
        <span className="auth-node auth-node-a"></span>
        <span className="auth-node auth-node-b"></span>
        <span className="auth-node auth-node-c"></span>
      </div>
      <div className="auth-hero">
        <p className="eyebrow">Open source software for a small trusted orbit</p>
        <h1>isputnik</h1>
      </div>
      <section className="auth-panel">
        <div className="brand-row">
          <img src="/Assets/brand/isputnik-app-icon.svg" alt="" />
          <div>
            <strong>isputnik.home</strong>
            <span>our world revolves around you.</span>
          </div>
        </div>
        {children}
      </section>
    </main>
  );
}

function InstallPage({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  return (
    <AccountForm
      title="Create the setup admin"
      eyebrow="First run"
      submitLabel="Create admin"
      helper="This account is marked as protected in SQLite and cannot be deleted from user management."
      onSubmit={async (payload) => {
        await api("/api/setup/admin", { method: "POST", body: JSON.stringify(payload) });
        await onSignedIn();
        navigate("/");
      }}
    />
  );
}

function LoginPage({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      await onSignedIn();
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to sign in");
    }
  };

  return (
    <Shell>
      <form className="stack" onSubmit={submit}>
        <p className="eyebrow">Welcome back</p>
        <h1>Sign in</h1>
        <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="username" />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          minLength={8}
          autoComplete="current-password"
        />
        {error && <MessageBox tone="error" title="Unable to sign in">{error}</MessageBox>}
        <button className="primary-button">Sign in</button>
      </form>
    </Shell>
  );
}

function InvitePage({ token, onSignedIn }: { token: string; onSignedIn: () => Promise<void> }) {
  const [inviteRole, setInviteRole] = useState<string>("");
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ invite: { role: string } }>(`/api/invites/${token}`)
      .then((payload) => setInviteRole(payload.invite.role))
      .catch((err) => setError(err instanceof Error ? err.message : "Invite is unavailable"));
  }, [token]);

  if (error) {
    return <Shell><MessageBox tone="error" title="Invite unavailable">{error}</MessageBox></Shell>;
  }

  return (
    <AccountForm
      title="Accept invite"
      eyebrow={inviteRole ? `${inviteRole} account` : "Invite"}
      submitLabel="Create account"
      helper="Invite links are single-use. After your account is created, the invite is consumed."
      onSubmit={async (payload) => {
        await api(`/api/invites/${token}/accept`, { method: "POST", body: JSON.stringify(payload) });
        await onSignedIn();
        navigate("/");
      }}
    />
  );
}

function AccountForm({
  eyebrow,
  title,
  submitLabel,
  helper,
  onSubmit
}: {
  eyebrow: string;
  title: string;
  submitLabel: string;
  helper: string;
  onSubmit: (payload: { displayName: string; email: string; password: string }) => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("Password and confirmation must match.");
      return;
    }

    try {
      await onSubmit({ displayName, email, password });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create account");
    }
  };

  return (
    <Shell>
      <form className="stack" onSubmit={submit}>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <MessageBox tone="info" title="Account setup">{helper}</MessageBox>
        <MessageBox tone="warning" title="Password policy">
          Use at least 8 characters. A memorable example pattern is two words, a number, and a symbol, like{" "}
          <code>River7Table!</code>.
        </MessageBox>
        <Field label="Display name" value={displayName} onChange={setDisplayName} autoComplete="name" />
        <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="username" />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          minLength={8}
          autoComplete="new-password"
        />
        <Field
          label="Confirm password"
          type="password"
          value={confirmPassword}
          onChange={setConfirmPassword}
          minLength={8}
          autoComplete="new-password"
        />
        {error && <MessageBox tone="error" title="Account setup needs attention">{error}</MessageBox>}
        <button className="primary-button">{submitLabel}</button>
      </form>
    </Shell>
  );
}

function HomePage({ user, logout }: { user: PublicUser; logout: () => Promise<void> }) {
  return (
    <DashboardShell active="home" user={user} logout={logout}>
      <section className="work-area">
        <p className="eyebrow">Home</p>
        <h1>Welcome, {user.displayName}</h1>
        <div className="empty-state">
          <img src="/Assets/brand/isputnik-app-icon.svg" alt="" />
          <h2>isputnik.home</h2>
          <p className="muted">Your private family space is ready.</p>
        </div>
      </section>
    </DashboardShell>
  );
}

function ProfilePage({
  user,
  logout,
  onUpdated
}: {
  user: PublicUser;
  logout: () => Promise<void>;
  onUpdated: (user: PublicUser) => void;
}) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [theme, setTheme] = useState(user.theme);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState("");

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    setStatus("saving");
    setError("");
    try {
      const payload = await api<{ user: PublicUser }>("/api/profile", {
        method: "PATCH",
        body: JSON.stringify({ displayName, theme })
      });
      onUpdated(payload.user);
      setStatus("saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save profile");
      setStatus("idle");
    }
  };

  return (
    <DashboardShell active="profile" user={user} logout={logout}>
      <section className="work-area profile-area">
        <p className="eyebrow">Profile</p>
        <h1>Your account</h1>
        <form className="profile-form" onSubmit={saveProfile}>
          <div className="profile-heading">
            <span className="avatar large" aria-hidden="true"><UserRound size={28} /></span>
            <div>
              <strong>{user.displayName}</strong>
              <span>{user.email}</span>
            </div>
          </div>
          <Field label="Display name" value={displayName} onChange={setDisplayName} autoComplete="name" />
          <label className="field">
            <span>Appearance</span>
            <span className="theme-switcher" role="radiogroup" aria-label="Theme preference">
              <ThemeOption icon={<Monitor size={17} />} label="System" selected={theme === "system"} onClick={() => setTheme("system")} />
              <ThemeOption icon={<Sun size={17} />} label="Light" selected={theme === "light"} onClick={() => setTheme("light")} />
              <ThemeOption icon={<Moon size={17} />} label="Dark" selected={theme === "dark"} onClick={() => setTheme("dark")} />
            </span>
          </label>
          {error && <MessageBox tone="error" title="Unable to save">{error}</MessageBox>}
          {status === "saved" && <MessageBox tone="success" title="Profile updated">Your settings have been saved.</MessageBox>}
          <button className="primary-button" disabled={status === "saving"}>
            {status === "saving" ? "Saving..." : "Save changes"}
          </button>
        </form>
      </section>
    </DashboardShell>
  );
}

function AboutPage({ user, logout }: { user: PublicUser; logout: () => Promise<void> }) {
  const [about, setAbout] = useState<AboutInfo | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ about: AboutInfo }>("/api/about")
      .then((payload) => setAbout(payload.about))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load application information"));
  }, []);

  return (
    <DashboardShell active="about" user={user} logout={logout}>
      <section className="work-area about-area">
        <p className="eyebrow">Application</p>
        <h1>About</h1>
        {error && <MessageBox tone="error" title="About error">{error}</MessageBox>}
        {about && <AboutDetails about={about} />}
      </section>
    </DashboardShell>
  );
}

function ThemeOption({
  icon,
  label,
  selected,
  onClick
}: {
  icon: React.ReactNode;
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button className={selected ? "selected" : ""} type="button" role="radio" aria-checked={selected} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function formatManagedDate(value: string) {
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function formatUptime(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatLogName(event: string) {
  return event.replaceAll(".", " ");
}

function ControlPanelPage({
  section,
  user,
  logout
}: {
  section: ControlSection;
  user: PublicUser;
  logout: () => Promise<void>;
}) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [invites, setInvites] = useState<ManagedInvite[]>([]);
  const [sessions, setSessions] = useState<ManagedSession[]>([]);
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [logSearchInput, setLogSearchInput] = useState("");
  const [logSearch, setLogSearch] = useState("");
  const [logPage, setLogPage] = useState(1);
  const [logPageSize, setLogPageSize] = useState(25);
  const [logTotal, setLogTotal] = useState(0);
  const [logTotalPages, setLogTotalPages] = useState(1);
  const [retentionDays, setRetentionDays] = useState(365);
  const [logCleanupStatus, setLogCleanupStatus] = useState("");
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [about, setAbout] = useState<AboutInfo | null>(null);
  const [createInviteOpen, setCreateInviteOpen] = useState(false);
  const [inviteUrl, setInviteUrl] = useState("");
  const [error, setError] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ManagedUser | null>(null);
  const [pendingInviteDelete, setPendingInviteDelete] = useState<ManagedInvite | null>(null);
  const [pendingSessionRevoke, setPendingSessionRevoke] = useState<ManagedSession | null>(null);
  const [pendingLogCleanup, setPendingLogCleanup] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [savingRoleId, setSavingRoleId] = useState("");

  const loadUsers = useCallback(async () => {
    const payload = await api<{ users: ManagedUser[] }>("/api/users");
    setUsers(payload.users);
  }, []);

  const loadInvites = useCallback(async () => {
    const payload = await api<{ invites: ManagedInvite[] }>("/api/invites");
    setInvites(payload.invites);
  }, []);

  const loadSessions = useCallback(async () => {
    const payload = await api<{ sessions: ManagedSession[] }>("/api/sessions");
    setSessions(payload.sessions);
  }, []);

  const loadLogs = useCallback(async () => {
    const query = new URLSearchParams({
      page: String(logPage),
      pageSize: String(logPageSize)
    });
    if (logSearch) {
      query.set("q", logSearch);
    }
    const payload = await api<{ logs: LogEvent[]; page: number; pageSize: number; total: number; totalPages: number }>(`/api/logs?${query}`);
    setLogs(payload.logs);
    setLogPage(payload.page);
    setLogTotal(payload.total);
    setLogTotalPages(payload.totalPages);
  }, [logPage, logPageSize, logSearch]);

  const loadStatus = useCallback(async () => {
    const payload = await api<{ status: SystemStatus }>("/api/status");
    setSystemStatus(payload.status);
  }, []);

  const loadAbout = useCallback(async () => {
    const payload = await api<{ about: AboutInfo }>("/api/about");
    setAbout(payload.about);
  }, []);

  useEffect(() => {
    setError("");
    const loadSection = {
      users: loadUsers,
      invites: loadInvites,
      sessions: loadSessions,
      logs: loadLogs,
      status: loadStatus,
      about: loadAbout
    }[section];
    loadSection().catch((err) => setError(err instanceof Error ? err.message : "Unable to load management records"));
  }, [loadAbout, loadInvites, loadLogs, loadSessions, loadStatus, loadUsers, section]);

  const createInvite = async () => {
    setCreating(true);
    setError("");
    try {
      const payload = await api<{ invite: { url: string } }>("/api/invites", {
        method: "POST",
        body: JSON.stringify({ role: "member", expiresInDays: 7 })
      });
      setInviteUrl(payload.invite.url);
      await loadInvites();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create invite link");
    } finally {
      setCreating(false);
    }
  };

  useEffect(() => {
    if (!pendingDelete && !pendingInviteDelete && !pendingSessionRevoke && !pendingLogCleanup && !createInviteOpen) {
      return;
    }

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !deleting && !creating) {
        setPendingDelete(null);
        setPendingInviteDelete(null);
        setPendingSessionRevoke(null);
        setPendingLogCleanup(false);
        setCreateInviteOpen(false);
      }
    };

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [pendingDelete, pendingInviteDelete, pendingSessionRevoke, pendingLogCleanup, createInviteOpen, deleting, creating]);

  const changeRole = async (account: ManagedUser, role: "admin" | "member") => {
    setSavingRoleId(account.id);
    setError("");
    try {
      await api(`/api/users/${account.id}/role`, {
        method: "PATCH",
        body: JSON.stringify({ role })
      });
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to change account role");
    } finally {
      setSavingRoleId("");
    }
  };

  const deleteUser = async () => {
    if (!pendingDelete) {
      return;
    }

    setDeleting(true);
    setError("");
    try {
      await api(`/api/users/${pendingDelete.id}`, { method: "DELETE" });
      setPendingDelete(null);
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete user");
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  };

  const deleteInvite = async () => {
    if (!pendingInviteDelete) {
      return;
    }

    setDeleting(true);
    setError("");
    try {
      await api(`/api/invites/${pendingInviteDelete.id}`, { method: "DELETE" });
      setPendingInviteDelete(null);
      await loadInvites();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete invite link");
      setPendingInviteDelete(null);
    } finally {
      setDeleting(false);
    }
  };

  const revokeSession = async () => {
    if (!pendingSessionRevoke) {
      return;
    }

    setDeleting(true);
    setError("");
    try {
      await api(`/api/sessions/${pendingSessionRevoke.id}`, { method: "DELETE" });
      setPendingSessionRevoke(null);
      await loadSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to revoke session");
      setPendingSessionRevoke(null);
    } finally {
      setDeleting(false);
    }
  };

  const submitLogSearch = (event: FormEvent) => {
    event.preventDefault();
    const query = logSearchInput.trim();
    setLogCleanupStatus("");
    if (query === logSearch && logPage === 1) {
      loadLogs().catch((err) => setError(err instanceof Error ? err.message : "Unable to search logs"));
      return;
    }
    setLogPage(1);
    setLogSearch(query);
  };

  const deleteOldLogs = async () => {
    setDeleting(true);
    setError("");
    setLogCleanupStatus("");
    try {
      const payload = await api<{ deleted: number }>("/api/logs", {
        method: "DELETE",
        body: JSON.stringify({ olderThanDays: retentionDays })
      });
      setPendingLogCleanup(false);
      setLogCleanupStatus(`${payload.deleted} log ${payload.deleted === 1 ? "entry" : "entries"} deleted.`);
      if (logPage === 1) {
        await loadLogs();
      } else {
        setLogPage(1);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete old logs");
      setPendingLogCleanup(false);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <DashboardShell active="control" user={user} logout={logout}>
      <div className="control-panel">
        <aside className="control-nav">
          <nav className="control-links" aria-label="Management">
            <div className="control-group">
              <p>Application</p>
              <a className={section === "status" ? "active" : ""} href="/control/status" onClick={(event) => followRoute(event, "/control/status")}>Status</a>
              <a className={section === "logs" ? "active" : ""} href="/control/logs" onClick={(event) => followRoute(event, "/control/logs")}>Logs</a>
              <a className={section === "about" ? "active" : ""} href="/control/about" onClick={(event) => followRoute(event, "/control/about")}>About</a>
            </div>
            <div className="control-group">
              <p>User administration</p>
              <a className={section === "users" ? "active" : ""} href="/control/users" onClick={(event) => followRoute(event, "/control/users")}>Users</a>
              <a className={section === "invites" ? "active" : ""} href="/control/invites" onClick={(event) => followRoute(event, "/control/invites")}>Invite links</a>
              <a className={section === "sessions" ? "active" : ""} href="/control/sessions" onClick={(event) => followRoute(event, "/control/sessions")}>Sessions</a>
            </div>
          </nav>
        </aside>
        <section className="work-area control-work">
          {section === "users" ? (
            <>
              <div className="section-head">
                <div>
                  <p className="eyebrow">Management</p>
                  <h1>User management</h1>
                </div>
              </div>

              {error && <MessageBox tone="error" title="User management error">{error}</MessageBox>}

              <div className="user-list">
                {users.map((account) => (
                  <article className="user-row" key={account.id}>
                    <div>
                      <strong>{account.displayName}</strong>
                      <span>{account.email}</span>
                      <span>{account.activeSessions} active {account.activeSessions === 1 ? "session" : "sessions"}</span>
                    </div>
                    <div className="user-controls">
                      <label>
                        <span className="sr-only">Role for {account.displayName}</span>
                        <select
                          className="role-select"
                          value={account.role}
                          disabled={account.protectedFromDelete || account.id === user.id || savingRoleId === account.id}
                          onChange={(event) => changeRole(account, event.target.value as "admin" | "member")}
                        >
                          <option value="member">Member</option>
                          <option value="admin">Admin</option>
                        </select>
                      </label>
                      {account.protectedFromDelete && <span className="protected-badge">Protected</span>}
                    </div>
                    <button
                      className="text-button"
                      disabled={account.protectedFromDelete || account.id === user.id}
                      onClick={() => setPendingDelete(account)}
                    >
                      Delete
                    </button>
                  </article>
                ))}
              </div>
            </>
          ) : section === "invites" ? (
            <>
              <div className="section-head">
                <div>
                  <p className="eyebrow">Management</p>
                  <h1>Invite links</h1>
                </div>
                <button
                  className="icon-button with-label"
                  onClick={() => {
                    setInviteUrl("");
                    setError("");
                    setCreateInviteOpen(true);
                  }}
                  title="New invite"
                >
                  <UserPlus size={18} />
                  <span>New invite</span>
                </button>
              </div>

              {error && <MessageBox tone="error" title="Invite links error">{error}</MessageBox>}

              <div className="invite-list">
                {invites.map((invite) => (
                  <article className="invite-row" key={invite.id}>
                    <div className="invite-summary">
                      <strong>{invite.role === "admin" ? "Admin" : "Member"} invite</strong>
                      <span>Created by {invite.createdByName} on {formatManagedDate(invite.createdAt)}</span>
                    </div>
                    <span className={`invite-status ${invite.status}`}>{invite.status}</span>
                    <div className="invite-dates">
                      <span>Expires {formatManagedDate(invite.expiresAt)}</span>
                      {invite.usedAt && <span>Used {formatManagedDate(invite.usedAt)}{invite.usedByName ? ` by ${invite.usedByName}` : ""}</span>}
                    </div>
                    <button className="text-button" onClick={() => setPendingInviteDelete(invite)}>
                      Delete
                    </button>
                    {invite.url ? (
                      <div className="invite-link">
                        <input value={invite.url} readOnly aria-label="Invite link" />
                        <button className="icon-button" onClick={() => navigator.clipboard.writeText(invite.url!)} title="Copy invite">
                          <Copy size={18} />
                        </button>
                      </div>
                    ) : (
                      <span className="invite-link-unavailable">Link unavailable for invitations created before link storage was enabled.</span>
                    )}
                  </article>
                ))}
                {invites.length === 0 && <p className="management-empty">No invite links found.</p>}
              </div>
            </>
          ) : section === "sessions" ? (
            <>
              <div className="section-head">
                <div>
                  <p className="eyebrow">Management</p>
                  <h1>Active sessions</h1>
                </div>
              </div>

              {error && <MessageBox tone="error" title="Session management error">{error}</MessageBox>}

              <div className="session-list">
                {sessions.map((session) => (
                  <article className="session-row" key={session.id}>
                    <div className="session-owner">
                      <strong>{session.displayName}</strong>
                      <span>{session.email}</span>
                    </div>
                    <div className="session-meta">
                      <span>Last seen {formatManagedDate(session.lastSeen)}</span>
                      <span>Expires {formatManagedDate(session.expiresAt)}</span>
                      <span>{session.deviceName ?? "Unknown device"}{session.ipAddress ? ` - ${session.ipAddress}` : ""}</span>
                    </div>
                    {session.current ? (
                      <span className="current-badge">Current</span>
                    ) : (
                      <button className="text-button" onClick={() => setPendingSessionRevoke(session)}>
                        Revoke
                      </button>
                    )}
                  </article>
                ))}
                {sessions.length === 0 && <p className="management-empty">No active sessions found.</p>}
              </div>
            </>
          ) : section === "logs" ? (
            <>
              <div className="section-head">
                <div>
                  <p className="eyebrow">Management</p>
                  <h1>Logs</h1>
                </div>
              </div>

              {error && <MessageBox tone="error" title="Logs error">{error}</MessageBox>}
              {logCleanupStatus && <MessageBox tone="success" title="Logs deleted">{logCleanupStatus}</MessageBox>}

              <div className="log-controls">
                <form className="log-search" onSubmit={submitLogSearch}>
                  <input
                    type="search"
                    value={logSearchInput}
                    onChange={(event) => setLogSearchInput(event.target.value)}
                    placeholder="Search logs"
                    aria-label="Search logs"
                  />
                  <button className="secondary-button compact-button">Search</button>
                </form>
                <label className="log-page-size">
                  <span>Rows</span>
                  <select
                    value={logPageSize}
                    onChange={(event) => {
                      setLogPage(1);
                      setLogPageSize(Number(event.target.value));
                    }}
                  >
                    <option value={10}>10</option>
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                  </select>
                </label>
                <div className="log-retention">
                  <label>
                    <span>Delete older than</span>
                    <input
                      type="number"
                      min={1}
                      max={3650}
                      value={retentionDays}
                      onChange={(event) => setRetentionDays(Math.max(1, Math.min(3650, Number(event.target.value) || 365)))}
                    />
                    <span>days</span>
                  </label>
                  <button className="danger-button compact-button" onClick={() => setPendingLogCleanup(true)}>
                    Delete old logs
                  </button>
                </div>
              </div>

              {logs.length > 0 ? (
                <>
                  <div className="log-table-wrap">
                    <table className="log-table">
                      <thead>
                        <tr>
                          <th>Time</th>
                          <th>Event</th>
                          <th>Detail</th>
                          <th>User</th>
                          <th>IP address</th>
                        </tr>
                      </thead>
                      <tbody>
                        {logs.map((entry) => (
                          <tr key={entry.id}>
                            <td>{formatManagedDate(entry.createdAt)}</td>
                            <td className="log-event">{formatLogName(entry.event)}</td>
                            <td>{entry.detail}</td>
                            <td>{entry.actorName ?? "System"}</td>
                            <td>{entry.ipAddress ?? "-"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="log-pager">
                    <span>{(logPage - 1) * logPageSize + 1}-{Math.min(logPage * logPageSize, logTotal)} of {logTotal}</span>
                    <div>
                      <button className="secondary-button pager-button" disabled={logPage === 1} onClick={() => setLogPage((page) => page - 1)}>
                        Previous
                      </button>
                      <span>Page {logPage} of {logTotalPages}</span>
                      <button className="secondary-button pager-button" disabled={logPage === logTotalPages} onClick={() => setLogPage((page) => page + 1)}>
                        Next
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <p className="management-empty">No log entries found.</p>
              )}
            </>
          ) : section === "status" ? (
            <>
              <div className="section-head">
                <div>
                  <p className="eyebrow">System</p>
                  <h1>Status</h1>
                </div>
                <button className="secondary-button compact-button" onClick={() => loadStatus().catch((err) => setError(err instanceof Error ? err.message : "Unable to refresh status"))}>
                  Refresh
                </button>
              </div>

              {error && <MessageBox tone="error" title="Status error">{error}</MessageBox>}

              {systemStatus && (
                <>
                  <div className="health-line">
                    <span className="health-dot" aria-hidden="true"></span>
                    <strong>{systemStatus.health}</strong>
                    <span>Updated {formatManagedDate(systemStatus.generatedAt)}</span>
                  </div>
                  <div className="status-grid">
                    <StatusMetric label="Users" value={String(systemStatus.users)} />
                    <StatusMetric label="Active sessions" value={String(systemStatus.activeSessions)} />
                    <StatusMetric label="Active invites" value={String(systemStatus.activeInvites)} />
                    <StatusMetric label="Log entries" value={String(systemStatus.logEntries)} />
                    <StatusMetric label="Database size" value={formatBytes(systemStatus.databaseBytes)} />
                    <StatusMetric label="Server uptime" value={formatUptime(systemStatus.uptimeSeconds)} />
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              <div className="section-head">
                <div>
                  <p className="eyebrow">Application</p>
                  <h1>About</h1>
                </div>
              </div>

              {error && <MessageBox tone="error" title="About error">{error}</MessageBox>}

              {about && <AboutDetails about={about} />}
            </>
          )}
        </section>
      </div>
      {createInviteOpen && (
        <div className="modal-backdrop" onMouseDown={() => !creating && setCreateInviteOpen(false)}>
          <section
            className="confirm-modal create-invite-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-invite-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="create-invite-title">Create invite link</h2>
            {!inviteUrl ? (
              <p>A member invite link will be created and will expire in 7 days.</p>
            ) : (
              <section className="created-invite" aria-label="New invite link">
                <strong>New invite link</strong>
                <div className="invite-box">
                  <input value={inviteUrl} readOnly />
                  <button className="icon-button" onClick={() => navigator.clipboard.writeText(inviteUrl)} title="Copy invite">
                    <Copy size={18} />
                  </button>
                </div>
              </section>
            )}
            {error && !inviteUrl && <MessageBox tone="error" title="Unable to create invite">{error}</MessageBox>}
            <div className="modal-actions">
              {!inviteUrl && (
                <button className="secondary-button" onClick={() => setCreateInviteOpen(false)} disabled={creating} autoFocus>
                  Cancel
                </button>
              )}
              {inviteUrl ? (
                <button className="primary-button" onClick={() => setCreateInviteOpen(false)} autoFocus>
                  Done
                </button>
              ) : (
                <button className="primary-button" onClick={createInvite} disabled={creating}>
                  {creating ? "Creating..." : "Create link"}
                </button>
              )}
            </div>
          </section>
        </div>
      )}
      {pendingDelete && (
        <div className="modal-backdrop" onMouseDown={() => !deleting && setPendingDelete(null)}>
          <section
            className="confirm-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-user-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="delete-user-title">Delete {pendingDelete.displayName}?</h2>
            <p>This account will be deactivated and signed out on all devices.</p>
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setPendingDelete(null)} disabled={deleting} autoFocus>
                Cancel
              </button>
              <button className="danger-button" onClick={deleteUser} disabled={deleting}>
                {deleting ? "Deleting..." : "Delete user"}
              </button>
            </div>
          </section>
        </div>
      )}
      {pendingInviteDelete && (
        <div className="modal-backdrop" onMouseDown={() => !deleting && setPendingInviteDelete(null)}>
          <section
            className="confirm-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-invite-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="delete-invite-title">Delete invite link?</h2>
            <p>This invite link will no longer be usable.</p>
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setPendingInviteDelete(null)} disabled={deleting} autoFocus>
                Cancel
              </button>
              <button className="danger-button" onClick={deleteInvite} disabled={deleting}>
                {deleting ? "Deleting..." : "Delete link"}
              </button>
            </div>
          </section>
        </div>
      )}
      {pendingSessionRevoke && (
        <div className="modal-backdrop" onMouseDown={() => !deleting && setPendingSessionRevoke(null)}>
          <section
            className="confirm-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="revoke-session-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="revoke-session-title">Revoke session?</h2>
            <p>{pendingSessionRevoke.displayName} will need to sign in again on this device.</p>
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setPendingSessionRevoke(null)} disabled={deleting} autoFocus>
                Cancel
              </button>
              <button className="danger-button" onClick={revokeSession} disabled={deleting}>
                {deleting ? "Revoking..." : "Revoke session"}
              </button>
            </div>
          </section>
        </div>
      )}
      {pendingLogCleanup && (
        <div className="modal-backdrop" onMouseDown={() => !deleting && setPendingLogCleanup(false)}>
          <section
            className="confirm-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-logs-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="delete-logs-title">Delete old logs?</h2>
            <p>All log entries older than {retentionDays} days will be permanently deleted.</p>
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setPendingLogCleanup(false)} disabled={deleting} autoFocus>
                Cancel
              </button>
              <button className="danger-button" onClick={deleteOldLogs} disabled={deleting}>
                {deleting ? "Deleting..." : "Delete logs"}
              </button>
            </div>
          </section>
        </div>
      )}
    </DashboardShell>
  );
}

function StatusMetric({ label, value }: { label: string; value: string }) {
  return (
    <article className="status-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function AboutDetails({ about }: { about: AboutInfo }) {
  return (
    <section className="about-panel">
      <div className="about-heading">
        <img src="/Assets/brand/isputnik-app-icon.svg" alt="" />
        <div>
          <h2>{about.name}</h2>
          <span>Version {about.version}</span>
        </div>
      </div>
      <p>{about.description}</p>
      <dl className="about-details">
        <div><dt>Frontend</dt><dd>{about.frontend}</dd></div>
        <div><dt>Server</dt><dd>{about.server}</dd></div>
        <div><dt>Runtime</dt><dd>{about.runtime}</dd></div>
        <div><dt>Database</dt><dd>{about.database}</dd></div>
      </dl>
      <section className="version-updates" aria-label="Version updates">
        <h2>Version updates</h2>
        {about.versionUpdates.map((update) => (
          <article className="version-update" key={update.version}>
            <div>
              <strong>Version {update.version}</strong>
              <span>{update.label}</span>
            </div>
            <ul>
              {update.changes.map((change) => <li key={change}>{change}</li>)}
            </ul>
          </article>
        ))}
      </section>
    </section>
  );
}

function DashboardShell({
  active,
  user,
  logout,
  children
}: {
  active: "home" | "about" | "profile" | "control";
  user: PublicUser;
  logout: () => Promise<void>;
  children: React.ReactNode;
}) {
  const isAdmin = user.role === "admin";
  const isControlPanel = active === "control";

  return (
    <main className={`dashboard ${isControlPanel ? "control-dashboard" : ""}`}>
      <header className="app-header">
        <a className="header-brand app-brand" href="/" onClick={(event) => followRoute(event, "/")} title="Home">
          <img src="/Assets/brand/isputnik-app-icon.svg" alt="" />
          <strong>isputnik.home</strong>
        </a>
        <div className="header-actions">
          {isAdmin && (
            <a
              className={`header-button ${active === "control" ? "active" : ""}`}
              href="/control/status"
              onClick={(event) => followRoute(event, "/control/status")}
              title="App control panel"
              aria-label="App control panel"
            >
              <Settings size={20} />
            </a>
          )}
          <button className={`user-button ${active === "profile" ? "active" : ""}`} onClick={() => navigate("/profile")} title="Your profile">
            <span>{user.displayName}</span>
            <span className="avatar" aria-hidden="true"><UserRound size={19} /></span>
          </button>
        </div>
      </header>
      <div className={`dashboard-body ${isControlPanel ? "control-body" : ""}`}>
        {!isControlPanel && (
          <aside className="sidebar">
            <nav className="side-nav">
              <button className={active === "home" ? "active" : ""} onClick={() => navigate("/")} title="Home">
                <Home size={22} />
                <span className="sr-only">Home</span>
              </button>
              <button className={active === "about" ? "active" : ""} onClick={() => navigate("/about")} title="About">
                <Info size={22} />
                <span className="sr-only">About</span>
              </button>
            </nav>
            <div className="rail-foot">
              <button className="logout-button" onClick={logout} title="Sign out">
                <LogOut size={21} />
                <span className="sr-only">Sign out</span>
              </button>
              <span className="version">v0.1.0</span>
            </div>
          </aside>
        )}
        <div className="dashboard-main">
          {children}
        </div>
      </div>
    </main>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  minLength,
  autoComplete
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  minLength?: number;
  autoComplete?: string;
}) {
  const id = useMemo(() => label.toLowerCase().replace(/\s+/g, "-"), [label]);

  return (
    <label className="field" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        type={type}
        value={value}
        minLength={minLength}
        autoComplete={autoComplete}
        onChange={(event) => onChange(event.target.value)}
        required
      />
    </label>
  );
}

function MessageBox({
  tone,
  title,
  children
}: {
  tone: "info" | "warning" | "error" | "success";
  title: string;
  children: React.ReactNode;
}) {
  const Icon = {
    info: Info,
    warning: AlertTriangle,
    error: XCircle,
    success: CheckCircle2
  }[tone];

  return (
    <div className={`message-box ${tone}`} role={tone === "error" ? "alert" : "status"}>
      <Icon size={18} aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <p>{children}</p>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
