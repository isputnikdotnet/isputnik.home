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
  Users,
  XCircle
} from "lucide-react";
import { api, type PublicUser } from "./api";
import "./styles.css";

type Route =
  | { name: "install" }
  | { name: "login" }
  | { name: "home" }
  | { name: "admin" }
  | { name: "profile" }
  | { name: "invite"; token: string };

interface SessionState {
  loading: boolean;
  requiresSetup: boolean;
  user: PublicUser | null;
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

  if (path === "/admin") {
    return { name: "admin" };
  }

  if (path === "/profile") {
    return { name: "profile" };
  }

  return { name: "home" };
}

function navigate(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
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

    if (session.user && route.name === "admin" && session.user.role !== "admin") {
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

  if (route.name === "admin") {
    return session.user.role === "admin"
      ? <AdminPage user={session.user} logout={logout} />
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

function AdminPage({ user, logout }: { user: PublicUser; logout: () => Promise<void> }) {
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [inviteUrl, setInviteUrl] = useState("");
  const [error, setError] = useState("");

  const loadUsers = useCallback(async () => {
    const payload = await api<{ users: PublicUser[] }>("/api/users");
    setUsers(payload.users);
  }, []);

  useEffect(() => {
    loadUsers().catch((err) => setError(err instanceof Error ? err.message : "Unable to load users"));
  }, [loadUsers]);

  const createInvite = async () => {
    setError("");
    const payload = await api<{ invite: { url: string } }>("/api/invites", {
      method: "POST",
      body: JSON.stringify({ role: "member", expiresInDays: 7 })
    });
    setInviteUrl(payload.invite.url);
  };

  const deleteUser = async (id: string) => {
    setError("");
    try {
      await api(`/api/users/${id}`, { method: "DELETE" });
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete user");
    }
  };

  return (
    <DashboardShell active="admin" user={user} logout={logout}>
      <section className="work-area">
        <div className="section-head">
          <div>
            <p className="eyebrow">Admin</p>
            <h1>User management</h1>
          </div>
          <button className="icon-button with-label" onClick={createInvite} title="Create invite">
            <UserPlus size={18} />
            <span>Invite</span>
          </button>
        </div>

        {inviteUrl && (
          <div className="invite-box">
            <input value={inviteUrl} readOnly />
            <button className="icon-button" onClick={() => navigator.clipboard.writeText(inviteUrl)} title="Copy invite">
              <Copy size={18} />
            </button>
          </div>
        )}

        {error && <MessageBox tone="error" title="User management error">{error}</MessageBox>}

        <div className="user-list">
          {users.map((account) => (
            <article className="user-row" key={account.id}>
              <div>
                <strong>{account.displayName}</strong>
                <span>{account.email}</span>
              </div>
              <div className="badges">
                <span>{account.role}</span>
                {account.protectedFromDelete && <span>protected</span>}
              </div>
              <button
                className="text-button"
                disabled={account.protectedFromDelete || account.id === user.id}
                onClick={() => deleteUser(account.id)}
              >
                Delete
              </button>
            </article>
          ))}
        </div>
      </section>
    </DashboardShell>
  );
}

function DashboardShell({
  active,
  user,
  logout,
  children
}: {
  active: "home" | "profile" | "admin";
  user: PublicUser;
  logout: () => Promise<void>;
  children: React.ReactNode;
}) {
  const isAdmin = user.role === "admin";

  return (
    <main className="dashboard">
      <aside className="sidebar">
        <button className="rail-brand" onClick={() => navigate("/")} title="isputnik.home">
          <img src="/Assets/brand/isputnik-app-icon.svg" alt="" />
        </button>
        <nav className="side-nav">
          <button className={active === "home" ? "active" : ""} onClick={() => navigate("/")} title="Home">
            <Home size={22} />
            <span className="sr-only">Home</span>
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
      <div className="dashboard-main">
        <header className="app-header">
          <div className="header-brand">
            <strong>isputnik.home</strong>
          </div>
          <div className="header-actions">
            <details className="settings-menu">
              <summary className="header-button" title="Configuration">
                <Settings size={20} />
                <span className="sr-only">Configuration</span>
              </summary>
              <div className="menu-panel">
                <button onClick={() => navigate("/profile")}>
                  <Settings size={17} />
                  Appearance
                </button>
                {isAdmin && (
                  <button onClick={() => navigate("/admin")}>
                    <Users size={17} />
                    Users
                  </button>
                )}
              </div>
            </details>
            <button className={`user-button ${active === "profile" ? "active" : ""}`} onClick={() => navigate("/profile")} title="Your profile">
              <span>{user.displayName}</span>
              <span className="avatar" aria-hidden="true"><UserRound size={19} /></span>
            </button>
          </div>
        </header>
        {children}
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
